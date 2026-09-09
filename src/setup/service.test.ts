import { describe, expect, it, vi } from 'vitest';
import { SetupConfigPatch, SetupStoredConfig } from './config-store';
import { ProcessLock } from './process-lock';
import { createTelegramPairingNonce } from './providers';
import { RuntimeController, RuntimeStatus } from './runtime';
import { createSetupService, SetupServiceError } from './service';

const TOKEN = '12345:abcdefghijklmnopqrstuvwxyz';
const API_KEY = 'sk-or-v1-private-key';

function cloneConfig(config: SetupStoredConfig): SetupStoredConfig {
    return { settings: { ...config.settings }, credentials: { ...config.credentials } };
}

function configMemory(initial: SetupStoredConfig = { settings: {}, credentials: {} }) {
    let value = cloneConfig(initial);
    return {
        read: () => cloneConfig(value),
        update: (_dataDir: string, patch: SetupConfigPatch, options: { overwrite?: boolean } = {}) => {
            for (const [key, next] of Object.entries(patch.settings || {})) {
                const current = value.settings[key as keyof typeof value.settings];
                if (!options.overwrite && current !== undefined && current !== next) throw new Error('overwrite');
            }
            for (const [key, next] of Object.entries(patch.credentials || {})) {
                const current = value.credentials[key as keyof typeof value.credentials];
                if (!options.overwrite && current !== undefined && current !== next) throw new Error('overwrite');
            }
            value = {
                settings: { ...value.settings, ...patch.settings },
                credentials: { ...value.credentials, ...patch.credentials },
            };
            return cloneConfig(value);
        },
        current: () => cloneConfig(value),
    };
}

function stoppedStatus(): RuntimeStatus {
    return {
        state: 'stopped',
        dataDir: '/test/data',
        background: false,
        message: 'Stopped.',
    };
}

function runtimeController(overrides: Partial<RuntimeController> = {}): RuntimeController {
    let current = stoppedStatus();
    return {
        status: vi.fn(async () => current),
        start: vi.fn(async ({ mode }) => {
            current = {
                state: 'ready',
                dataDir: '/test/data',
                mode,
                background: mode === 'background',
                message: 'Ready.',
            };
            return current;
        }),
        stop: vi.fn(async () => {
            current = stoppedStatus();
            return current;
        }),
        backgroundSupport: vi.fn(() => ({
            supported: true,
            platform: 'darwin' as NodeJS.Platform,
            explanation: 'Available.',
        })),
        ...overrides,
    };
}

function lockFactory() {
    const locks: Array<{ released: boolean }> = [];
    const acquire = vi.fn((_dataDir: string, _owner: 'setup'): ProcessLock => {
        const state = { released: false };
        locks.push(state);
        return {
            owner: 'setup',
            runId: `00000000-0000-4000-8000-${String(locks.length).padStart(12, '0')}`,
            dataDir: '/test/data',
            markReady: vi.fn(),
            release: vi.fn(() => {
                state.released = true;
            }),
        };
    });
    return { acquire, locks };
}

function readyConfig(owner = ''): SetupStoredConfig {
    return {
        settings: {
            LLM_PROVIDER: 'openrouter',
            LLM_EXECUTOR_MODEL: 'test/model',
            LLM_TOOLS_PROVIDER: 'openrouter',
            LLM_TOOLS_MODEL: 'test/model',
            ...(owner ? { OWNER_TG_IDS: owner } : {}),
        },
        credentials: { OPENROUTER_API_KEY: API_KEY, TELEGRAM_BOT_TOKEN: TOKEN },
    };
}

function successFetch(updates?: unknown[]): typeof fetch {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/getMe')) {
            return new Response(
                JSON.stringify({
                    ok: true,
                    result: { id: 12345, is_bot: true, username: 'pipi_test_bot', first_name: 'PiPi' },
                })
            );
        }
        if (url.endsWith('/getWebhookInfo')) {
            return new Response(JSON.stringify({ ok: true, result: { url: '', pending_update_count: 0 } }));
        }
        if (url.endsWith('/getUpdates')) {
            return new Response(JSON.stringify({ ok: true, result: updates || [] }));
        }
        if (url.includes('/chat/completions')) {
            const body = JSON.parse(String(init?.body));
            if (body.tool_choice === 'none') {
                return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready.' } }] }));
            }
            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                role: 'assistant',
                                content: null,
                                tool_calls: [
                                    {
                                        id: 'call-1',
                                        function: {
                                            name: 'pipi_setup_probe',
                                            arguments: '{"value":"ready"}',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
            );
        }
        throw new Error(`unexpected test URL: ${url}`);
    }) as typeof fetch;
}

describe('setup service', () => {
    it('keeps JSON status read-only, lock-free, and free of credentials', async () => {
        const config = configMemory(readyConfig('77'));
        const lock = lockFactory();
        const request = vi.fn<typeof fetch>();
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            readOnly: true,
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lock.acquire,
            fetch: request,
        });

        const state = await service.status();
        expect(lock.acquire).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(state.provider).toMatchObject({ configured: true, validated: false });
        expect(state.telegram).toMatchObject({ configured: true, validated: false });
        expect(JSON.stringify(state)).not.toContain(API_KEY);
        expect(JSON.stringify(state)).not.toContain(TOKEN);
        await expect(service.validateConnections()).rejects.toMatchObject({ code: 'read_only' });
    });

    it('keeps connection edits locked while runtime is active but saves owner preferences live', async () => {
        let running = true;
        const runtime = runtimeController({
            status: vi.fn(
                async (): Promise<RuntimeStatus> =>
                    running
                        ? {
                              state: 'ready' as const,
                              dataDir: '/test/data',
                              mode: 'background' as const,
                              background: true,
                              message: 'Ready.',
                          }
                        : stoppedStatus()
            ),
            stop: vi.fn(async () => {
                running = false;
                return stoppedStatus();
            }),
        });
        const config = configMemory();
        const lock = lockFactory();
        const saveProfileCard = vi.fn(async () => undefined);
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime,
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lock.acquire,
            fetch: successFetch(),
            saveProfileCard,
        });

        expect(lock.acquire).not.toHaveBeenCalled();
        expect((await service.status()).phase).toBe('running');
        await expect(service.setManualOpenRouterKey('sk-or-v1-replacement')).rejects.toMatchObject({
            code: 'runtime_active',
        });
        const updated = await service.setMetadata({ language: 'ru', timezone: 'Europe/Rome' });
        expect(saveProfileCard).toHaveBeenCalledWith({ language: 'ru', timezone: 'Europe/Rome' });
        expect(config.current().settings.TZ).toBe('Europe/Rome');
        expect(updated.metadata).toMatchObject({ language: 'ru', timezone: 'Europe/Rome' });
        expect(lock.acquire).not.toHaveBeenCalled();
        await service.stopRuntime();
        expect(lock.acquire).toHaveBeenCalledTimes(1);
    });

    it('reclaims a stale runtime claim after a crash and resumes setup mutations', async () => {
        const config = configMemory();
        const lock = lockFactory();
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController({
                status: vi.fn(
                    async (): Promise<RuntimeStatus> => ({
                        state: 'error',
                        dataDir: '/test/data',
                        mode: 'background',
                        background: true,
                        message: 'The previous runtime stopped without a clean shutdown.',
                    })
                ),
            }),
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lock.acquire,
            fetch: successFetch(),
        });

        expect(lock.acquire).toHaveBeenCalledTimes(1);
        await service.setMetadata({ language: 'en', timezone: 'UTC' });
        expect(config.current().settings.TZ).toBe('UTC');
    });

    it('saves optional owner context only through the explicit callback and keeps it out of safe status', async () => {
        const config = configMemory();
        let extension = { language: 'it', timezone: 'Europe/Rome', profilePresent: false };
        const saveProfileCard = vi.fn(async () => {
            extension = { ...extension, profilePresent: true };
        });
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lockFactory().acquire,
            fetch: successFetch(),
            getStatusExtension: () => extension,
            saveProfileCard,
        });

        const state = await service.setMetadata({
            language: 'it',
            timezone: 'Europe/Rome',
            profile: { facts: [' Prefers concise replies '], currentTask: ' Plan the week ' },
        });
        expect(saveProfileCard).toHaveBeenCalledWith({
            language: 'it',
            timezone: 'Europe/Rome',
            facts: ['Prefers concise replies'],
            currentTask: 'Plan the week',
        });
        expect(state.metadata.profilePresent).toBe(true);
        expect(JSON.stringify(state)).not.toContain('Prefers concise replies');

        const withoutStorage = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lockFactory().acquire,
            fetch: successFetch(),
        });
        await expect(
            withoutStorage.setMetadata({
                language: 'it',
                timezone: 'Europe/Rome',
                profile: { facts: ['private'] },
            })
        ).rejects.toMatchObject({ code: 'profile_storage_unavailable' });
    });

    it('pairs only the correlated private account and makes confirmation single-use', async () => {
        const random = (size: number) => new Uint8Array(size).fill(9);
        const nonce = createTelegramPairingNonce(random);
        const updates = [
            {
                update_id: 1,
                message: {
                    text: `/start ${nonce}`,
                    chat: { id: 88, type: 'private' },
                    from: { id: 88, username: 'owner', first_name: 'Owner', language_code: 'en' },
                },
            },
        ];
        const config = configMemory(readyConfig());
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lockFactory().acquire,
            fetch: successFetch(updates),
            randomBytes: random,
        });

        const pairing = await service.beginOwnerPairing();
        expect(pairing.pairing.link).toContain(nonce);
        await vi.waitFor(async () => {
            expect((await service.status({ includeEphemeral: true })).pairing.candidate?.id).toBe('88');
        });
        const safe = await service.status();
        expect(safe.pairing.link).toBeUndefined();
        expect(safe.pairing.candidate).toBeUndefined();

        await expect(service.confirmOwner('99')).rejects.toMatchObject({ code: 'owner_candidate_mismatch' });
        await service.confirmOwner('88');
        expect(config.current().settings.OWNER_TG_IDS).toBe('88');
        await expect(service.confirmOwner('88')).rejects.toMatchObject({ code: 'owner_already_configured' });
    });

    it('expires and cancels pending Telegram polling without saving an owner', async () => {
        let now = 1_000;
        let pollAborted = false;
        const baseFetch = successFetch();
        const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).endsWith('/getUpdates')) return baseFetch(input, init);
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    pollAborted = true;
                    reject(new DOMException('aborted', 'AbortError'));
                });
            });
        }) as typeof fetch;
        const config = configMemory(readyConfig());
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lockFactory().acquire,
            fetch: request,
            now: () => now,
            randomBytes: (size) => new Uint8Array(size).fill(4),
        });

        await service.beginOwnerPairing();
        now += 10 * 60 * 1000;
        const expired = await service.status({ includeEphemeral: true });
        expect(expired.issue?.code).toBe('pairing_expired');
        expect(expired.pairing.active).toBe(false);
        expect(pollAborted).toBe(true);
        expect(config.current().settings.OWNER_TG_IDS).toBeUndefined();
    });

    it('rejects environment conflicts and concurrent submissions without leaking values', async () => {
        const config = configMemory();
        const request = successFetch();
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {
                OPENROUTER_API_KEY: API_KEY,
                LLM_PROVIDER: 'openrouter',
                LLM_EXECUTOR_MODEL: 'test/model',
                LLM_TOOLS_PROVIDER: 'openrouter',
            },
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lockFactory().acquire,
            fetch: request,
        });
        await expect(service.setManualOpenRouterKey('sk-or-v1-different')).rejects.toMatchObject({
            code: 'environment_conflict',
        });
        const state = await service.status();
        expect(JSON.stringify(state)).not.toContain('different');

        let release!: (response: Response) => void;
        const pending = new Promise<Response>((resolve) => {
            release = resolve;
        });
        const emptyConfig = configMemory();
        const concurrent = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {},
            readConfig: emptyConfig.read,
            updateConfig: emptyConfig.update,
            acquireLock: lockFactory().acquire,
            fetch: vi.fn(() => pending) as unknown as typeof fetch,
        });
        const first = concurrent.setManualOpenRouterKey(API_KEY);
        await expect(concurrent.setTelegramToken(TOKEN)).rejects.toMatchObject({ code: 'operation_in_progress' });
        release(new Response('{}', { status: 503 }));
        await expect(first).rejects.toBeInstanceOf(SetupServiceError);
    });

    it('lets an explicit rerun replace an invalid stored key when no operator override exists', async () => {
        const oldKey = 'sk-or-v1-invalid-stored';
        const newKey = 'sk-or-v1-valid-replacement';
        const config = configMemory({
            ...readyConfig('77'),
            credentials: { OPENROUTER_API_KEY: oldKey, TELEGRAM_BOT_TOKEN: TOKEN },
        });
        const valid = successFetch();
        const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (
                String(input).includes('/chat/completions') &&
                (init?.headers as Record<string, string> | undefined)?.authorization === `Bearer ${oldKey}`
            ) {
                return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
            }
            return valid(input, init);
        }) as typeof fetch;
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime: runtimeController(),
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lockFactory().acquire,
            fetch: request,
        });

        expect((await service.status()).provider.status).toBe('error');
        await service.setManualOpenRouterKey(newKey);
        expect(config.current().credentials.OPENROUTER_API_KEY).toBe(newKey);
        expect((await service.status()).provider.status).toBe('ready');
    });

    it('releases setup ownership before starting and reports dialogue verification separately', async () => {
        const config = configMemory(readyConfig('77'));
        const lock = lockFactory();
        const runtime = runtimeController();
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime,
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lock.acquire,
            fetch: successFetch(),
            getStatusExtension: () => ({ currentPack: 'jeeves', dialogueVerified: false }),
        });

        const state = await service.startRuntime('foreground');
        expect(lock.locks[0].released).toBe(true);
        expect(runtime.start).toHaveBeenCalledWith({ mode: 'foreground' });
        expect(state.runtime.state).toBe('ready');
        expect(state.runtime.dialogueVerified).toBe(false);
        expect(state.phase).toBe('running');
    });

    it('promotes a proven foreground conversation to background and keeps repeat starts idempotent', async () => {
        const config = configMemory(readyConfig('77'));
        const lock = lockFactory();
        const runtime = runtimeController();
        let dialogueVerified = false;
        const service = await createSetupService({
            dataDir: '/test/data',
            runtime,
            operatorEnv: {},
            readConfig: config.read,
            updateConfig: config.update,
            acquireLock: lock.acquire,
            fetch: successFetch(),
            getStatusExtension: () => ({ currentPack: 'jeeves', dialogueVerified }),
        });

        await service.startRuntime('foreground');
        await expect(service.startRuntime('background')).rejects.toMatchObject({
            code: 'dialogue_not_verified',
        });
        expect(runtime.start).toHaveBeenCalledTimes(1);

        dialogueVerified = true;
        const promoted = await service.startRuntime('background');
        expect(promoted.runtime).toMatchObject({ state: 'ready', mode: 'background', dialogueVerified: true });
        expect(runtime.start).toHaveBeenNthCalledWith(2, { mode: 'background' });

        const repeated = await service.startRuntime('background');
        expect(repeated.runtime).toMatchObject({ state: 'ready', mode: 'background' });
        expect(runtime.start).toHaveBeenCalledTimes(2);
        await expect(service.setTelegramToken(TOKEN)).rejects.toMatchObject({ code: 'runtime_active' });
    });
});
