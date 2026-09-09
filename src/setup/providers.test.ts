import { describe, expect, it, vi } from 'vitest';
import {
    buildTelegramPairingLink,
    createOpenRouterOAuthAttempt,
    exchangeOpenRouterCode,
    pollTelegramOwnerCandidate,
    SetupProviderError,
    validateOpenRouterConnection,
    validateTelegramConnection,
} from './providers';

const jsonResponse = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('OpenRouter setup provider', () => {
    it('creates a bounded localhost S256 attempt with callback state', () => {
        let byte = 0;
        const attempt = createOpenRouterOAuthAttempt({
            callbackBaseUrl: 'http://127.0.0.1:43123',
            now: 1_000,
            randomBytes: (size) => Uint8Array.from({ length: size }, () => byte++),
        });

        const authorization = new URL(attempt.authorizationUrl);
        expect(authorization.origin).toBe('https://openrouter.ai');
        expect(authorization.pathname).toBe('/auth');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorization.searchParams.get('callback_url')).toBe(
            `http://127.0.0.1:43123/api/setup/openrouter/callback/${attempt.state}`
        );
        expect(attempt.expiresAt).toBe(601_000);
        expect(authorization.search).not.toContain(attempt.verifier);
    });

    it('exchanges a code without returning provider response details', async () => {
        const attempt = createOpenRouterOAuthAttempt({
            callbackBaseUrl: 'http://localhost:1234',
            randomBytes: (size) => new Uint8Array(size).fill(7),
        });
        const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ key: 'sk-or-v1-private' }));

        await expect(exchangeOpenRouterCode('one-time-code', attempt, { fetch: request })).resolves.toBe(
            'sk-or-v1-private'
        );
        const body = JSON.parse(String(request.mock.calls[0][1]?.body));
        expect(body).toEqual({
            code: 'one-time-code',
            code_verifier: attempt.verifier,
            code_challenge_method: 'S256',
        });

        request.mockReset().mockResolvedValue(jsonResponse({ error: 'secret provider body' }, 403));
        const error = await exchangeOpenRouterCode('bad-code', attempt, { fetch: request }).catch(
            (caught: SetupProviderError) => caught
        );
        expect(error).toMatchObject({ code: 'provider_auth' });
        if (!(error instanceof SetupProviderError)) throw new Error('expected setup provider error');
        expect(error.message).not.toContain('secret provider body');
    });

    it('requires a real tool call followed by a text continuation', async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    choices: [
                        {
                            message: {
                                role: 'assistant',
                                content: null,
                                tool_calls: [
                                    {
                                        id: 'call-1',
                                        type: 'function',
                                        function: {
                                            name: 'pipi_setup_probe',
                                            arguments: JSON.stringify({ value: 'ready' }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
            )
            .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Ready.' } }] }));

        await expect(
            validateOpenRouterConnection({ apiKey: 'sk-or-v1-private', model: 'vendor/tool-model' }, { fetch: request })
        ).resolves.toEqual({ model: 'vendor/tool-model', textReady: true, toolRoundTripReady: true });
        expect(request).toHaveBeenCalledTimes(2);
        const first = JSON.parse(String(request.mock.calls[0][1]?.body));
        const second = JSON.parse(String(request.mock.calls[1][1]?.body));
        expect(first.tool_choice.function.name).toBe('pipi_setup_probe');
        expect(second.messages.at(-1)).toEqual({
            role: 'tool',
            tool_call_id: 'call-1',
            content: '{"ok":true,"value":"ready"}',
        });
        expect(second.tool_choice).toBe('none');
    });

    it('rejects a model that calls the probe with different arguments', async () => {
        const request = vi.fn<typeof fetch>().mockResolvedValue(
            jsonResponse({
                choices: [
                    {
                        message: {
                            tool_calls: [
                                {
                                    id: 'call-1',
                                    function: { name: 'pipi_setup_probe', arguments: '{"value":"wrong"}' },
                                },
                            ],
                        },
                    },
                ],
            })
        );
        await expect(
            validateOpenRouterConnection({ apiKey: 'sk-or-v1-private' }, { fetch: request })
        ).rejects.toMatchObject({ code: 'provider_response' });
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe('Telegram setup provider', () => {
    it('checks bot identity and webhook state without changing the webhook', async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    ok: true,
                    result: { id: 12345, is_bot: true, username: 'pipi_test_bot', first_name: 'PiPi' },
                })
            )
            .mockResolvedValueOnce(
                jsonResponse({ ok: true, result: { url: 'https://example.invalid/hook', pending_update_count: 3 } })
            );

        await expect(
            validateTelegramConnection('12345:abcdefghijklmnopqrstuvwxyz', { fetch: request })
        ).resolves.toEqual({
            bot: { id: '12345', username: 'pipi_test_bot', firstName: 'PiPi' },
            webhookActive: true,
            pendingUpdateCount: 3,
        });
        const calledMethods = request.mock.calls.map(([url]) => String(url).split('/').at(-1));
        expect(calledMethods).toEqual(['getMe', 'getWebhookInfo']);
        expect(calledMethods).not.toContain('deleteWebhook');
    });

    it('accepts only the exact nonce from a private self chat and captures sender metadata', async () => {
        const nonce = 'abcdefghijklmnopqrstuvwxyz123456';
        const request = vi.fn<typeof fetch>().mockResolvedValue(
            jsonResponse({
                ok: true,
                result: [
                    {
                        update_id: 1,
                        message: {
                            text: `/start ${nonce}`,
                            chat: { id: -100, type: 'group' },
                            from: { id: 44, first_name: 'Wrong' },
                        },
                    },
                    {
                        update_id: 2,
                        message: {
                            text: '/start abcdefghijklmnop',
                            chat: { id: 44, type: 'private' },
                            from: { id: 44, first_name: 'Wrong nonce' },
                        },
                    },
                    {
                        update_id: 3,
                        message: {
                            text: `/start@pipi_test_bot ${nonce}`,
                            chat: { id: 55, type: 'private' },
                            from: {
                                id: 55,
                                username: 'amy',
                                first_name: 'Amy',
                                last_name: 'Owner',
                                language_code: 'en',
                            },
                        },
                    },
                ],
            })
        );
        const candidate = vi.fn();

        await pollTelegramOwnerCandidate({
            token: '12345:abcdefghijklmnopqrstuvwxyz',
            botUsername: 'pipi_test_bot',
            nonce,
            expiresAt: 2_000,
            signal: new AbortController().signal,
            onCandidate: candidate,
            fetch: request,
            now: () => 1_000,
        });

        expect(candidate).toHaveBeenCalledWith({
            id: '55',
            username: 'amy',
            firstName: 'Amy',
            lastName: 'Owner',
            languageCode: 'en',
        });
        expect(buildTelegramPairingLink('pipi_test_bot', nonce)).toBe(`https://t.me/pipi_test_bot?start=${nonce}`);
    });

    it('does not poll after the pairing attempt expires', async () => {
        const request = vi.fn<typeof fetch>();
        await pollTelegramOwnerCandidate({
            token: '12345:abcdefghijklmnopqrstuvwxyz',
            botUsername: 'pipi_test_bot',
            nonce: 'abcdefghijklmnopqrstuvwxyz123456',
            expiresAt: 1_000,
            signal: new AbortController().signal,
            onCandidate: vi.fn(),
            fetch: request,
            now: () => 1_000,
        });
        expect(request).not.toHaveBeenCalled();
    });
});
