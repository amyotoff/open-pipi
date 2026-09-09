import {
    readSetupConfig,
    SetupConfigError,
    SetupConfigPatch,
    SetupStoredConfig,
    updateSetupConfig,
} from './config-store';
import { acquireProcessLock, ProcessLock, ProcessLockError } from './process-lock';
import { RuntimeLifecycleError, type BackgroundSupport, type RuntimeController, type RuntimeStatus } from './runtime';
import {
    buildTelegramPairingLink,
    createOpenRouterOAuthAttempt,
    createTelegramPairingNonce,
    DEFAULT_OPENROUTER_MODEL,
    exchangeOpenRouterCode,
    OpenRouterOAuthAttempt,
    pollTelegramOwnerCandidate,
    SetupProviderError,
    TelegramConnection,
    TelegramOwnerCandidate,
    validateOpenRouterConnection,
    validateTelegramConnection,
} from './providers';

export type SetupConnectionStatus = 'missing' | 'checking' | 'ready' | 'error';
export type SetupOwnerStatus = SetupConnectionStatus | 'pairing' | 'candidate';
export type SetupStage = 'ai' | 'telegram' | 'owner' | 'ready' | 'running';
export type SetupRuntimeMode = 'foreground' | 'background';

export type SetupSafeError = {
    code: string;
    message: string;
    action?: string;
    retryable: boolean;
    target: 'setup' | 'ai' | 'telegram' | 'owner' | 'runtime';
};

export type SetupStatusExtension = {
    currentPack?: string;
    characterCustomized?: boolean;
    profilePresent?: boolean;
    dialogueVerified?: boolean;
    language?: string;
    timezone?: string;
    preferencesPending?: boolean;
};

export type SetupProfileCard = {
    facts?: string[];
    currentTask?: string;
};

export type SetupOwnerContextInput = SetupProfileCard & {
    language: string;
    timezone: string;
    displayName?: string;
};

export type SetupSafeStatus = {
    phase: SetupStage;
    language?: string;
    timezone?: string;
    metadata: { language?: string; timezone?: string; profilePresent: boolean; preferencesPending?: boolean };
    provider: {
        status: SetupConnectionStatus;
        kind: string;
        model: string;
        configured: boolean;
        validated: boolean;
        error?: string;
    };
    telegram: {
        status: SetupConnectionStatus;
        configured: boolean;
        validated: boolean;
        botUsername?: string;
        bot?: { username: string; firstName: string };
        webhookConflict: boolean;
        error?: string;
    };
    owners: { existing: boolean; count: number; status: SetupOwnerStatus };
    pairing: {
        active: boolean;
        link?: string;
        expiresAt?: string;
        candidate?: { id: string; displayName: string; username?: string };
    };
    profile: { initialPack: 'jeeves'; currentPack: string; customized?: boolean };
    runtime: RuntimeStatus & { dialogueVerified: boolean };
    background: BackgroundSupport;
    completed: boolean;
    issue?: SetupSafeError;
};

export class SetupServiceError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly action: string,
        readonly target: SetupSafeError['target'],
        readonly retryable = true
    ) {
        super(message);
        this.name = 'SetupServiceError';
    }
}

export type SetupServiceOptions = {
    dataDir: string;
    runtime: RuntimeController;
    readOnly?: boolean;
    operatorEnv?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
    readConfig?: (dataDir: string) => SetupStoredConfig;
    updateConfig?: (dataDir: string, patch: SetupConfigPatch, options?: { overwrite?: boolean }) => SetupStoredConfig;
    acquireLock?: (dataDir: string, owner: 'setup') => ProcessLock;
    getStatusExtension?: () => SetupStatusExtension | Promise<SetupStatusExtension>;
    saveProfileCard?: (context: SetupOwnerContextInput) => void | Promise<void>;
};

export interface SetupService {
    status(options?: { includeEphemeral?: boolean }): Promise<SetupSafeStatus>;
    setMetadata(input: { language?: string; timezone?: string; profile?: SetupProfileCard }): Promise<SetupSafeStatus>;
    beginOpenRouterOAuth(callbackBaseUrl: string): Promise<{ authorizationUrl: string }>;
    completeOpenRouterOAuth(state: string, code: string): Promise<SetupSafeStatus>;
    setManualOpenRouterKey(apiKey: string): Promise<SetupSafeStatus>;
    setTelegramToken(token: string): Promise<SetupSafeStatus>;
    beginOwnerPairing(): Promise<SetupSafeStatus>;
    confirmOwner(candidateId: string): Promise<SetupSafeStatus>;
    cancelOwnerPairing(): Promise<SetupSafeStatus>;
    validateConnections(): Promise<SetupSafeStatus>;
    startRuntime(mode: SetupRuntimeMode): Promise<SetupSafeStatus>;
    stopRuntime(): Promise<SetupSafeStatus>;
    dispose(): Promise<void>;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;

function trimmed(value: string | undefined): string {
    return value?.trim() || '';
}

function safeError(error: unknown, target: SetupSafeError['target']): SetupSafeError {
    if (error instanceof SetupServiceError) {
        return {
            code: error.code,
            message: error.message,
            action: error.action,
            retryable: error.retryable,
            target: error.target,
        };
    }
    if (error instanceof SetupProviderError) {
        return {
            code: error.code,
            message: error.message,
            action: error.action,
            retryable: error.retryable,
            target,
        };
    }
    if (error instanceof SetupConfigError) {
        return {
            code: error.code,
            message: 'The local setup configuration could not be updated.',
            action: 'Check the local data directory and try again.',
            retryable: true,
            target,
        };
    }
    if (error instanceof ProcessLockError) {
        return {
            code: error.code,
            message: 'Another Open PiPi process owns this installation.',
            action: 'Stop the other setup or runtime process, then try again.',
            retryable: true,
            target: 'setup',
        };
    }
    if (error instanceof RuntimeLifecycleError) {
        return {
            code: error.code,
            message: error.message,
            action:
                error.code === 'background_config_incomplete'
                    ? 'Restart setup without temporary exported overrides and reconnect here, or save those values in .env yourself.'
                    : 'Check the runtime status and try again.',
            retryable: true,
            target: 'runtime',
        };
    }
    return {
        code: 'unexpected_error',
        message: 'Setup could not complete that step.',
        action: 'Try the step again.',
        retryable: true,
        target,
    };
}

function throwFrom(error: SetupSafeError): never {
    throw new SetupServiceError(error.code, error.message, error.action || 'Try again.', error.target, error.retryable);
}

function candidateDisplayName(candidate: TelegramOwnerCandidate): string {
    return (
        [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || candidate.username || 'Telegram account'
    );
}

function telegramOwnerIds(effective: NodeJS.ProcessEnv): string[] {
    const telegram = trimmed(effective.OWNER_TG_IDS)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    const identities = trimmed(effective.OWNER_IDENTITIES)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.toLowerCase().startsWith('telegram:'))
        .map((entry) => entry.slice('telegram:'.length));
    return [...new Set([...telegram, ...identities])];
}

class SetupServiceImpl implements SetupService {
    private lock: ProcessLock | null = null;
    private oauthAttempt: OpenRouterOAuthAttempt | null = null;
    private pairing:
        | {
              nonce: string;
              link: string;
              expiresAt: number;
              controller: AbortController;
              candidate?: TelegramOwnerCandidate;
          }
        | undefined;
    private aiStatus: SetupConnectionStatus = 'missing';
    private telegramStatus: SetupConnectionStatus = 'missing';
    private telegramConnection?: TelegramConnection;
    private aiError?: SetupSafeError;
    private telegramError?: SetupSafeError;
    private ownerError?: SetupSafeError;
    private issue?: SetupSafeError;
    private language?: string;
    private busy = false;
    private disposed = false;
    private startedRuntime = false;
    private confirmedOwnerCandidate?: TelegramOwnerCandidate;

    constructor(
        private readonly options: Required<Pick<SetupServiceOptions, 'dataDir' | 'runtime'>> & SetupServiceOptions
    ) {}

    async initialize(): Promise<void> {
        const runtime = await this.options.runtime.status();
        if (!this.options.readOnly && (runtime.state === 'stopped' || runtime.state === 'error')) this.reacquireLock();
        if (this.options.readOnly) {
            const effective = this.effective();
            this.aiStatus = trimmed(effective.OPENROUTER_API_KEY) ? 'checking' : 'missing';
            this.telegramStatus = trimmed(effective.TELEGRAM_BOT_TOKEN) ? 'checking' : 'missing';
            return;
        }
        await this.probeConnections();
    }

    private readStored(): SetupStoredConfig {
        return (this.options.readConfig || readSetupConfig)(this.options.dataDir);
    }

    private updateStored(patch: SetupConfigPatch, overwrite = false): SetupStoredConfig {
        return (this.options.updateConfig || updateSetupConfig)(this.options.dataDir, patch, { overwrite });
    }

    private effective(stored = this.readStored()): NodeJS.ProcessEnv {
        return {
            ...stored.settings,
            ...stored.credentials,
            ...(this.options.operatorEnv || process.env),
        };
    }

    private assertNoEnvironmentConflict(values: Record<string, string>): void {
        const operatorEnv = this.options.operatorEnv || process.env;
        for (const [key, value] of Object.entries(values)) {
            const current = trimmed(operatorEnv[key]);
            if (current && current !== value) {
                throw new SetupServiceError(
                    'environment_conflict',
                    'An exported environment setting overrides this value.',
                    `Remove the ${key} override for this setup process, then try again.`,
                    'setup',
                    false
                );
            }
        }
    }

    private async exclusive<T>(target: SetupSafeError['target'], operation: () => Promise<T>): Promise<T> {
        if (this.disposed) {
            throw new SetupServiceError(
                'setup_closed',
                'This setup session is closed.',
                'Run pnpm setup again.',
                'setup'
            );
        }
        if (this.busy) {
            throw new SetupServiceError(
                'operation_in_progress',
                'Another setup step is still running.',
                'Wait for it to finish, then try again.',
                target
            );
        }
        this.busy = true;
        this.issue = undefined;
        try {
            const result = await operation();
            return result;
        } catch (error) {
            const sanitized = safeError(error, target);
            this.issue = sanitized;
            throwFrom(sanitized);
        } finally {
            this.busy = false;
        }
    }

    private assertWritable(): void {
        if (this.options.readOnly) {
            throw new SetupServiceError(
                'read_only',
                'This setup check is read-only.',
                'Run pnpm setup interactively to make changes.',
                'setup',
                false
            );
        }
    }

    private async requireSetupOwnership(): Promise<void> {
        this.assertWritable();
        const runtime = await this.options.runtime.status();
        if (runtime.state === 'ready' || runtime.state === 'starting') {
            throw new SetupServiceError(
                'runtime_active',
                'Open PiPi is running, so its configuration cannot be changed.',
                'Stop PiPi from this setup page before changing a connection.',
                'runtime',
                false
            );
        }
        this.reacquireLock();
    }

    private async probeAi(effective: NodeJS.ProcessEnv): Promise<void> {
        const key = trimmed(effective.OPENROUTER_API_KEY);
        const provider = trimmed(effective.LLM_PROVIDER) || 'openrouter';
        if (!key || provider !== 'openrouter') {
            this.aiStatus = 'missing';
            this.aiError = undefined;
            return;
        }

        this.aiStatus = 'checking';
        try {
            await validateOpenRouterConnection(
                { apiKey: key, model: trimmed(effective.LLM_EXECUTOR_MODEL) || DEFAULT_OPENROUTER_MODEL },
                { fetch: this.options.fetch }
            );
            if (trimmed(effective.LLM_TOOLS_PROVIDER) !== 'openrouter') {
                throw new SetupServiceError(
                    'provider_route_conflict',
                    'PiPi tools are configured to use a different AI connection.',
                    'Reconnect OpenRouter to use one connection for text and tools.',
                    'ai',
                    false
                );
            }
            this.aiStatus = 'ready';
            this.aiError = undefined;
        } catch (error) {
            this.aiStatus = 'error';
            this.aiError = safeError(error, 'ai');
        }
    }

    private async probeTelegram(effective: NodeJS.ProcessEnv): Promise<void> {
        const token = trimmed(effective.TELEGRAM_BOT_TOKEN);
        if (!token) {
            this.telegramStatus = 'missing';
            this.telegramConnection = undefined;
            this.telegramError = undefined;
            return;
        }

        this.telegramStatus = 'checking';
        try {
            const connection = await validateTelegramConnection(token, { fetch: this.options.fetch });
            this.telegramConnection = connection;
            if (connection.webhookActive) {
                this.telegramStatus = 'error';
                this.telegramError = safeError(
                    new SetupProviderError(
                        'telegram_webhook_active',
                        'This bot has an active webhook, so local pairing cannot receive updates.',
                        'Remove the webhook where it is managed, or use a different bot token.',
                        false
                    ),
                    'telegram'
                );
            } else {
                this.telegramStatus = 'ready';
                this.telegramError = undefined;
            }
        } catch (error) {
            this.telegramStatus = 'error';
            this.telegramConnection = undefined;
            this.telegramError = safeError(error, 'telegram');
        }
    }

    private async probeConnections(): Promise<void> {
        const effective = this.effective();
        await Promise.all([this.probeAi(effective), this.probeTelegram(effective)]);
    }

    private expirePairing(): void {
        if (!this.pairing || this.pairing.expiresAt > (this.options.now || Date.now)()) return;
        this.pairing.controller.abort();
        this.pairing = undefined;
        this.ownerError = safeError(
            new SetupServiceError(
                'pairing_expired',
                'The Telegram pairing link expired.',
                'Create a new pairing link.',
                'owner'
            ),
            'owner'
        );
        this.issue = this.ownerError;
    }

    async status(options: { includeEphemeral?: boolean } = {}): Promise<SetupSafeStatus> {
        this.expirePairing();
        const stored = this.readStored();
        const effective = this.effective(stored);
        const configuredOwnerIds = telegramOwnerIds(effective);
        const ownersExisting = configuredOwnerIds.length > 0;
        const extension = (await Promise.resolve(this.options.getStatusExtension?.()).catch(() => undefined)) || {};
        const runtime = await this.options.runtime.status();
        const candidate = this.pairing?.candidate;
        const pairingActive = Boolean(this.pairing);
        const ownerStatus: SetupOwnerStatus = ownersExisting
            ? 'ready'
            : candidate
              ? 'candidate'
              : pairingActive
                ? 'pairing'
                : this.ownerError
                  ? 'error'
                  : 'missing';
        const aiConfigured = Boolean(trimmed(effective.OPENROUTER_API_KEY));
        const telegramConfigured = Boolean(trimmed(effective.TELEGRAM_BOT_TOKEN));
        const complete = this.aiStatus === 'ready' && this.telegramStatus === 'ready' && ownersExisting;
        const stage: SetupStage =
            runtime.state === 'ready' || runtime.state === 'starting'
                ? 'running'
                : this.aiStatus !== 'ready'
                  ? 'ai'
                  : this.telegramStatus !== 'ready'
                    ? 'telegram'
                    : !ownersExisting
                      ? 'owner'
                      : 'ready';
        const model = trimmed(effective.LLM_EXECUTOR_MODEL) || DEFAULT_OPENROUTER_MODEL;
        const provider = trimmed(effective.LLM_PROVIDER) || 'openrouter';
        const currentPack = extension.currentPack || trimmed(effective.BOOTSTRAP_PACK) || 'jeeves';
        const language = this.language || trimmed(extension.language);
        const timezone = trimmed(effective.TZ) || trimmed(extension.timezone);
        const displayName = candidate ? candidateDisplayName(candidate) : undefined;
        const ephemeralCandidate =
            candidate && options.includeEphemeral
                ? {
                      id: candidate.id,
                      displayName: displayName as string,
                      ...(candidate.username ? { username: candidate.username } : {}),
                      ...(candidate.languageCode ? { languageCode: candidate.languageCode } : {}),
                  }
                : undefined;
        const expiresAt = this.pairing ? new Date(this.pairing.expiresAt).toISOString() : undefined;
        const pairingUrl = options.includeEphemeral ? this.pairing?.link : undefined;
        const issue = this.issue || this.aiError || this.telegramError || this.ownerError;
        const dialogueVerified = extension.dialogueVerified === true;
        const profile = {
            initialPack: 'jeeves' as const,
            currentPack,
            ...(extension.characterCustomized === undefined ? {} : { customized: extension.characterCustomized }),
        };

        return {
            phase: stage,
            ...(language ? { language } : {}),
            ...(timezone ? { timezone } : {}),
            metadata: {
                ...(language ? { language } : {}),
                ...(timezone ? { timezone } : {}),
                profilePresent: extension.profilePresent === true,
                ...(extension.preferencesPending === undefined
                    ? {}
                    : { preferencesPending: extension.preferencesPending }),
            },
            provider: {
                status: this.aiStatus,
                kind: provider,
                model,
                configured: aiConfigured,
                validated: this.aiStatus === 'ready',
                ...(this.aiError ? { error: this.aiError.message } : {}),
            },
            telegram: {
                status: this.telegramStatus,
                configured: telegramConfigured,
                validated: this.telegramStatus === 'ready',
                ...(this.telegramConnection
                    ? {
                          botUsername: this.telegramConnection.bot.username,
                          bot: {
                              username: this.telegramConnection.bot.username,
                              firstName: this.telegramConnection.bot.firstName,
                          },
                      }
                    : {}),
                webhookConflict: this.telegramConnection?.webhookActive === true,
                ...(this.telegramError ? { error: this.telegramError.message } : {}),
            },
            owners: { existing: ownersExisting, count: configuredOwnerIds.length, status: ownerStatus },
            pairing: {
                active: pairingActive,
                ...(pairingUrl ? { link: pairingUrl } : {}),
                ...(expiresAt ? { expiresAt } : {}),
                ...(ephemeralCandidate
                    ? {
                          candidate: {
                              id: ephemeralCandidate.id,
                              displayName: ephemeralCandidate.displayName,
                              ...(ephemeralCandidate.username ? { username: ephemeralCandidate.username } : {}),
                          },
                      }
                    : {}),
            },
            profile,
            runtime: { ...runtime, dialogueVerified },
            background: this.options.runtime.backgroundSupport(),
            completed: complete,
            ...(issue ? { issue } : {}),
        };
    }

    async setMetadata(input: {
        language?: string;
        timezone?: string;
        profile?: SetupProfileCard;
    }): Promise<SetupSafeStatus> {
        return this.exclusive('setup', async () => {
            this.assertWritable();
            const extension = (await Promise.resolve(this.options.getStatusExtension?.()).catch(() => undefined)) || {};
            let language = this.language || trimmed(extension.language);
            let timezone = trimmed(this.effective().TZ) || trimmed(extension.timezone);
            if (input.language !== undefined) {
                const requestedLanguage = input.language.trim();
                if (requestedLanguage && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(requestedLanguage)) {
                    throw new SetupServiceError(
                        'invalid_language',
                        'The browser language is not valid.',
                        'Choose a language and try again.',
                        'setup',
                        false
                    );
                }
                language = requestedLanguage;
            }
            if (input.timezone !== undefined) {
                const requestedTimezone = input.timezone.trim();
                if (requestedTimezone) {
                    try {
                        new Intl.DateTimeFormat('en', { timeZone: requestedTimezone }).format();
                    } catch {
                        throw new SetupServiceError(
                            'invalid_timezone',
                            'The browser timezone is not valid.',
                            'Choose a timezone and try again.',
                            'setup',
                            false
                        );
                    }
                }
                timezone = requestedTimezone;
            }
            if (!language || !timezone) {
                throw new SetupServiceError(
                    'profile_context_missing',
                    'Choose a language and timezone before saving owner context.',
                    'Choose both values and try again.',
                    'setup',
                    false
                );
            }

            let profile: SetupProfileCard | undefined;
            if (input.profile) {
                const facts = input.profile.facts?.map((fact) => fact.trim()).filter(Boolean) || [];
                const currentTask = input.profile.currentTask?.trim();
                if (facts.length > 5 || facts.some((fact) => fact.length > 240) || (currentTask?.length || 0) > 500) {
                    throw new SetupServiceError(
                        'invalid_profile',
                        'The optional profile card is too long.',
                        'Keep it to a few short facts and one current task.',
                        'setup',
                        false
                    );
                }
                profile = {
                    ...(facts.length ? { facts } : {}),
                    ...(currentTask ? { currentTask } : {}),
                };
            }
            if (input.profile && !this.options.saveProfileCard) {
                throw new SetupServiceError(
                    'profile_storage_unavailable',
                    'The optional profile card cannot be saved in this setup session.',
                    'Continue without the card, or restart setup.',
                    'setup',
                    false
                );
            }
            const candidate = this.pairing?.candidate || this.confirmedOwnerCandidate;
            this.assertNoEnvironmentConflict({ TZ: timezone });
            if (this.options.saveProfileCard) {
                await this.options.saveProfileCard({
                    language,
                    timezone,
                    ...(candidate ? { displayName: candidateDisplayName(candidate) } : {}),
                    ...profile,
                });
            }
            this.updateStored({ settings: { TZ: timezone } }, true);
            this.language = language;
            return this.status({ includeEphemeral: true });
        });
    }

    async beginOpenRouterOAuth(callbackBaseUrl: string): Promise<{ authorizationUrl: string }> {
        return this.exclusive('ai', async () => {
            await this.requireSetupOwnership();
            this.oauthAttempt = createOpenRouterOAuthAttempt({
                callbackBaseUrl,
                now: (this.options.now || Date.now)(),
                randomBytes: this.options.randomBytes,
            });
            return { authorizationUrl: this.oauthAttempt.authorizationUrl };
        });
    }

    private async storeOpenRouterKey(apiKey: string): Promise<void> {
        const settings = {
            LLM_PROVIDER: 'openrouter' as const,
            LLM_EXECUTOR_MODEL: DEFAULT_OPENROUTER_MODEL,
            LLM_TOOLS_PROVIDER: 'openrouter' as const,
            LLM_TOOLS_MODEL: DEFAULT_OPENROUTER_MODEL,
        };
        this.assertNoEnvironmentConflict({ OPENROUTER_API_KEY: apiKey, ...settings });
        this.aiStatus = 'checking';
        try {
            await validateOpenRouterConnection(
                { apiKey, model: DEFAULT_OPENROUTER_MODEL },
                { fetch: this.options.fetch }
            );
            this.updateStored({ settings, credentials: { OPENROUTER_API_KEY: apiKey } }, true);
            this.aiStatus = 'ready';
            this.aiError = undefined;
        } catch (error) {
            this.aiStatus = 'error';
            this.aiError = safeError(error, 'ai');
            throw error;
        }
    }

    async completeOpenRouterOAuth(state: string, code: string): Promise<SetupSafeStatus> {
        return this.exclusive('ai', async () => {
            await this.requireSetupOwnership();
            const attempt = this.oauthAttempt;
            this.oauthAttempt = null;
            if (!attempt || state !== attempt.state) {
                throw new SetupServiceError(
                    'oauth_state_mismatch',
                    'This OpenRouter return does not match the active setup session.',
                    'Start OpenRouter sign-in again.',
                    'ai',
                    false
                );
            }
            if ((this.options.now || Date.now)() >= attempt.expiresAt) {
                throw new SetupServiceError(
                    'oauth_expired',
                    'The OpenRouter sign-in expired.',
                    'Start OpenRouter sign-in again.',
                    'ai'
                );
            }
            const key = await exchangeOpenRouterCode(code, attempt, { fetch: this.options.fetch });
            await this.storeOpenRouterKey(key);
            return this.status({ includeEphemeral: true });
        });
    }

    async setManualOpenRouterKey(apiKey: string): Promise<SetupSafeStatus> {
        return this.exclusive('ai', async () => {
            await this.requireSetupOwnership();
            await this.storeOpenRouterKey(apiKey);
            return this.status({ includeEphemeral: true });
        });
    }

    async setTelegramToken(token: string): Promise<SetupSafeStatus> {
        return this.exclusive('telegram', async () => {
            await this.requireSetupOwnership();
            this.cancelPairingInternal();
            const normalized = token.trim();
            this.assertNoEnvironmentConflict({ TELEGRAM_BOT_TOKEN: normalized });
            this.telegramStatus = 'checking';
            let connection: TelegramConnection;
            try {
                connection = await validateTelegramConnection(normalized, { fetch: this.options.fetch });
            } catch (error) {
                this.telegramStatus = 'error';
                this.telegramConnection = undefined;
                this.telegramError = safeError(error, 'telegram');
                throw error;
            }
            this.updateStored({ credentials: { TELEGRAM_BOT_TOKEN: normalized } }, true);
            this.telegramConnection = connection;
            if (connection.webhookActive) {
                this.telegramStatus = 'error';
                this.telegramError = safeError(
                    new SetupProviderError(
                        'telegram_webhook_active',
                        'This bot has an active webhook, so local pairing cannot receive updates.',
                        'Remove the webhook where it is managed, or use a different bot token.',
                        false
                    ),
                    'telegram'
                );
            } else {
                this.telegramStatus = 'ready';
                this.telegramError = undefined;
            }
            return this.status({ includeEphemeral: true });
        });
    }

    async beginOwnerPairing(): Promise<SetupSafeStatus> {
        return this.exclusive('owner', async () => {
            await this.requireSetupOwnership();
            const effective = this.effective();
            if (telegramOwnerIds(effective).length > 0) {
                throw new SetupServiceError(
                    'owner_already_configured',
                    'An owner is already configured.',
                    'Use the owner management commands after startup to make changes.',
                    'owner',
                    false
                );
            }
            if (this.telegramStatus !== 'ready' || !this.telegramConnection) {
                throw new SetupServiceError(
                    'telegram_not_ready',
                    'Connect Telegram before pairing the owner.',
                    'Complete the Telegram step, then try again.',
                    'owner',
                    false
                );
            }
            if (!this.lock) {
                throw new SetupServiceError(
                    'setup_lock_missing',
                    'Setup no longer owns Telegram polling.',
                    'Stop PiPi, then run setup again.',
                    'owner',
                    false
                );
            }

            this.cancelPairingInternal();
            const nonce = createTelegramPairingNonce(this.options.randomBytes);
            const controller = new AbortController();
            const expiresAt = (this.options.now || Date.now)() + PAIRING_TTL_MS;
            this.pairing = {
                nonce,
                link: buildTelegramPairingLink(this.telegramConnection.bot.username, nonce),
                expiresAt,
                controller,
            };
            this.ownerError = undefined;
            const activePairing = this.pairing;
            void pollTelegramOwnerCandidate({
                token: trimmed(effective.TELEGRAM_BOT_TOKEN),
                botUsername: this.telegramConnection.bot.username,
                nonce,
                expiresAt,
                signal: controller.signal,
                onCandidate: (candidate) => {
                    if (this.pairing === activePairing) this.pairing.candidate = candidate;
                },
                fetch: this.options.fetch,
                now: this.options.now,
            }).catch((error: unknown) => {
                if (controller.signal.aborted || this.pairing !== activePairing) return;
                const sanitized = safeError(error, 'owner');
                this.ownerError = sanitized;
                this.issue = sanitized;
                this.pairing = undefined;
            });
            return this.status({ includeEphemeral: true });
        });
    }

    private cancelPairingInternal(): void {
        this.pairing?.controller.abort();
        this.pairing = undefined;
    }

    async confirmOwner(candidateId: string): Promise<SetupSafeStatus> {
        return this.exclusive('owner', async () => {
            await this.requireSetupOwnership();
            this.expirePairing();
            const effective = this.effective();
            if (telegramOwnerIds(effective).length > 0) {
                throw new SetupServiceError(
                    'owner_already_configured',
                    'An owner is already configured.',
                    'Use owner management after startup to make changes.',
                    'owner',
                    false
                );
            }
            const pairing = this.pairing;
            const candidate = pairing?.candidate;
            if (!pairing || !candidate) {
                throw new SetupServiceError(
                    'owner_candidate_missing',
                    'No Telegram account is waiting for confirmation.',
                    'Open the current pairing link in Telegram first.',
                    'owner',
                    false
                );
            }
            if (candidateId.trim() !== candidate.id) {
                throw new SetupServiceError(
                    'owner_candidate_mismatch',
                    'That account does not match the current pairing candidate.',
                    'Refresh the page and confirm the displayed account.',
                    'owner',
                    false
                );
            }

            this.confirmedOwnerCandidate = candidate;
            this.cancelPairingInternal();
            this.updateStored({
                settings: {
                    OWNER_TG_IDS: candidate.id,
                    ...(!trimmed(effective.BOOTSTRAP_GROUNDING) ? { BOOTSTRAP_GROUNDING: 'jeeves_starter' } : {}),
                },
            });
            this.ownerError = undefined;
            return this.status({ includeEphemeral: true });
        });
    }

    async cancelOwnerPairing(): Promise<SetupSafeStatus> {
        return this.exclusive('owner', async () => {
            await this.requireSetupOwnership();
            this.cancelPairingInternal();
            this.ownerError = undefined;
            return this.status({ includeEphemeral: true });
        });
    }

    async validateConnections(): Promise<SetupSafeStatus> {
        return this.exclusive('setup', async () => {
            await this.requireSetupOwnership();
            await this.probeConnections();
            return this.status({ includeEphemeral: true });
        });
    }

    async startRuntime(mode: SetupRuntimeMode): Promise<SetupSafeStatus> {
        return this.exclusive('runtime', async () => {
            this.assertWritable();
            const runtimeBefore = await this.options.runtime.status();
            const alreadyRequested =
                (runtimeBefore.state === 'ready' || runtimeBefore.state === 'starting') && runtimeBefore.mode === mode;
            if (alreadyRequested) return this.status({ includeEphemeral: true });

            const promotingForeground =
                mode === 'background' && runtimeBefore.state === 'ready' && runtimeBefore.mode === 'foreground';
            if (!promotingForeground) await this.requireSetupOwnership();
            const current = await this.status();
            if (!current.completed) {
                throw new SetupServiceError(
                    'setup_incomplete',
                    'AI, Telegram, and owner pairing must be ready before PiPi starts.',
                    'Complete the remaining setup step and retry.',
                    'runtime',
                    false
                );
            }
            if (mode === 'background' && !this.options.runtime.backgroundSupport().supported) {
                throw new SetupServiceError(
                    'background_unsupported',
                    'Background startup is not supported on this system.',
                    'Try PiPi in the current setup process instead.',
                    'runtime',
                    false
                );
            }
            if (mode === 'background' && !current.runtime.dialogueVerified) {
                throw new SetupServiceError(
                    'dialogue_not_verified',
                    'PiPi must reply in Telegram before background mode is enabled.',
                    'Send PiPi a message, wait for its reply, then try background mode again.',
                    'runtime',
                    false
                );
            }

            this.cancelPairingInternal();
            this.lock?.release();
            this.lock = null;
            try {
                const runtime = await this.options.runtime.start({ mode });
                this.startedRuntime = runtime.state === 'ready' || runtime.state === 'starting';
                if (runtime.state === 'error' || runtime.state === 'stopped') this.reacquireLock();
            } catch (error) {
                const runtime = await this.options.runtime.status();
                if (runtime.state === 'stopped' || runtime.state === 'error') this.reacquireLock();
                throw error;
            }
            return this.status({ includeEphemeral: true });
        });
    }

    private reacquireLock(): void {
        if (this.lock || this.disposed) return;
        const acquire = this.options.acquireLock || ((dataDir: string) => acquireProcessLock(dataDir, 'setup'));
        this.lock = acquire(this.options.dataDir, 'setup');
        this.lock.markReady();
    }

    async stopRuntime(): Promise<SetupSafeStatus> {
        return this.exclusive('runtime', async () => {
            this.assertWritable();
            this.cancelPairingInternal();
            const status = await this.options.runtime.stop();
            if (status.state === 'stopped') this.reacquireLock();
            return this.status({ includeEphemeral: true });
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelPairingInternal();
        try {
            const runtime = await this.options.runtime.status();
            if (this.startedRuntime && runtime.mode === 'foreground' && runtime.state !== 'stopped') {
                await this.options.runtime.stop();
            }
        } finally {
            this.lock?.release();
            this.lock = null;
        }
    }
}

export async function createSetupService(options: SetupServiceOptions): Promise<SetupService> {
    const service = new SetupServiceImpl(options);
    try {
        await service.initialize();
        return service;
    } catch (error) {
        await service.dispose();
        throw error;
    }
}
