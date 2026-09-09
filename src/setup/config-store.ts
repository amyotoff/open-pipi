import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

export const SETUP_SETTING_KEYS = [
    'LLM_PROVIDER',
    'LLM_EXECUTOR_MODEL',
    'LLM_ADVISOR_MODEL',
    'LLM_TOOLS_PROVIDER',
    'LLM_TOOLS_MODEL',
    'LLM_VISION_PROVIDER',
    'LLM_VISION_MODEL',
    'LLM_SEARCH_PROVIDER',
    'LLM_SEARCH_MODEL',
    'OWNER_TG_IDS',
    'OWNER_IDENTITIES',
    'BOT_DISPLAY_NAME',
    'BOOTSTRAP_PACK',
    'BOOTSTRAP_GROUNDING',
    'TZ',
] as const;

export const SETUP_CREDENTIAL_KEYS = [
    'TELEGRAM_BOT_TOKEN',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
] as const;

export type SetupSettingKey = (typeof SETUP_SETTING_KEYS)[number];
export type SetupCredentialKey = (typeof SETUP_CREDENTIAL_KEYS)[number];
export type SetupSettings = Partial<Record<SetupSettingKey, string>>;
export type SetupCredentials = Partial<Record<SetupCredentialKey, string>>;

export interface SetupConfigPatch {
    settings?: SetupSettings;
    credentials?: SetupCredentials;
}

export interface SetupStoredConfig {
    settings: SetupSettings;
    credentials: SetupCredentials;
}

export interface SetupConfigPaths {
    settings: string;
    credentials: string;
}

export type SetupConfigErrorCode =
    | 'invalid_data_dir'
    | 'unsafe_file'
    | 'corrupt_file'
    | 'invalid_key'
    | 'invalid_value'
    | 'already_configured'
    | 'operator_env_invalid'
    | 'write_failed';

export class SetupConfigError extends Error {
    constructor(
        public readonly code: SetupConfigErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'SetupConfigError';
    }
}

const settingKeys = new Set<string>(SETUP_SETTING_KEYS);
const credentialKeys = new Set<string>(SETUP_CREDENTIAL_KEYS);
const providerKeys = new Set<SetupSettingKey>([
    'LLM_PROVIDER',
    'LLM_TOOLS_PROVIDER',
    'LLM_VISION_PROVIDER',
    'LLM_SEARCH_PROVIDER',
]);
const safeIdKeys = new Set<SetupSettingKey>(['BOOTSTRAP_PACK', 'BOOTSTRAP_GROUNDING']);
const PROVIDERS = new Set(['openrouter', 'openai', 'anthropic', 'gemini']);
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/i;
function hasControlCharacter(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    });
}

export function getSetupConfigPaths(dataDir: string): SetupConfigPaths {
    const root = path.resolve(dataDir);
    return {
        settings: path.join(root, 'setup-settings.json'),
        credentials: path.join(root, 'setup-credentials.json'),
    };
}

export function loadOperatorEnvironment(
    cwd: string,
    exportedEnv: NodeJS.ProcessEnv,
    readEnvFile: (filePath: string) => string | undefined = (filePath) =>
        fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined
): NodeJS.ProcessEnv {
    let fileEnvironment: Record<string, string> = {};
    try {
        const content = readEnvFile(path.join(path.resolve(cwd), '.env'));
        if (content !== undefined) fileEnvironment = dotenv.parse(content);
    } catch {
        throw new SetupConfigError('operator_env_invalid', 'The operator environment file could not be loaded.');
    }

    const resolved: NodeJS.ProcessEnv = { ...fileEnvironment };
    for (const [key, value] of Object.entries(exportedEnv)) {
        if (value !== undefined) resolved[key] = value;
    }
    return resolved;
}

function ensureSafeRegularFile(filePath: string, privateFile: boolean): boolean {
    try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new SetupConfigError('unsafe_file', 'A setup configuration path is not a regular file.');
        }
        if (privateFile && (stat.mode & 0o077) !== 0) {
            throw new SetupConfigError('unsafe_file', 'A setup credential file has unsafe permissions.');
        }
        if (privateFile && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new SetupConfigError('unsafe_file', 'A setup credential file has an unexpected owner.');
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        if (error instanceof SetupConfigError) throw error;
        throw new SetupConfigError('unsafe_file', 'A setup configuration file could not be inspected.');
    }
}

function validateSetting(key: SetupSettingKey, raw: unknown): string {
    if (typeof raw !== 'string') {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    const value = raw.trim();
    if (!value || value.length > 512 || hasControlCharacter(value)) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    if (providerKeys.has(key) && !PROVIDERS.has(value.toLowerCase())) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    if (safeIdKeys.has(key) && !SAFE_ID.test(value)) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    if (key === 'OWNER_TG_IDS' && !value.split(',').every((entry) => /^\d+$/.test(entry.trim()))) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    if (
        key === 'OWNER_IDENTITIES' &&
        !value.split(',').every((entry) => /^[a-z][a-z0-9_-]*:[^\s,:]+$/i.test(entry.trim()))
    ) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    if (key === 'TZ') {
        try {
            new Intl.DateTimeFormat('en', { timeZone: value }).format();
        } catch {
            throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
        }
    }
    return providerKeys.has(key) ? value.toLowerCase() : value;
}

function validateCredential(key: SetupCredentialKey, raw: unknown): string {
    if (typeof raw !== 'string') {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    const value = raw.trim();
    if (value.length < 8 || value.length > 8192 || /\s/.test(value) || hasControlCharacter(value)) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    if (key === 'TELEGRAM_BOT_TOKEN' && !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(value)) {
        throw new SetupConfigError('invalid_value', `Invalid value for ${key}.`);
    }
    return value;
}

function parseFile<T extends SetupSettings | SetupCredentials>(
    filePath: string,
    allowedKeys: ReadonlySet<string>,
    validate: (key: never, value: unknown) => string,
    privateFile = false
): T {
    if (!ensureSafeRegularFile(filePath, privateFile)) return {} as T;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid shape');
        const output: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (!allowedKeys.has(key)) throw new Error('unknown key');
            output[key] = validate(key as never, value);
        }
        return output as T;
    } catch (error) {
        if (error instanceof SetupConfigError && error.code === 'unsafe_file') throw error;
        throw new SetupConfigError('corrupt_file', 'A local setup configuration file is invalid.');
    }
}

export function readSetupConfig(dataDir: string): SetupStoredConfig {
    const paths = getSetupConfigPaths(dataDir);
    return {
        settings: parseFile<SetupSettings>(paths.settings, settingKeys, validateSetting),
        credentials: parseFile<SetupCredentials>(paths.credentials, credentialKeys, validateCredential, true),
    };
}

function normalizePatch(patch: SetupConfigPatch): SetupStoredConfig {
    const settings: SetupSettings = {};
    const credentials: SetupCredentials = {};
    for (const [key, value] of Object.entries(patch.settings || {})) {
        if (!settingKeys.has(key)) throw new SetupConfigError('invalid_key', 'The setup setting is not supported.');
        settings[key as SetupSettingKey] = validateSetting(key as SetupSettingKey, value);
    }
    for (const [key, value] of Object.entries(patch.credentials || {})) {
        if (!credentialKeys.has(key)) {
            throw new SetupConfigError('invalid_key', 'The setup credential is not supported.');
        }
        credentials[key as SetupCredentialKey] = validateCredential(key as SetupCredentialKey, value);
    }
    return { settings, credentials };
}

function mergeWithoutSilentOverwrite<T extends Record<string, string | undefined>>(
    current: T,
    patch: T,
    overwrite: boolean
): T {
    const merged = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (!overwrite && current[key] !== undefined && current[key] !== value) {
            throw new SetupConfigError('already_configured', `${key} is already configured.`);
        }
        merged[key as keyof T] = value as T[keyof T];
    }
    return merged;
}

function ensureDataDirectory(dataDir: string): void {
    try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const stat = fs.lstatSync(dataDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe');
    } catch {
        throw new SetupConfigError('invalid_data_dir', 'The local data directory is unavailable.');
    }
}

function writeAtomic(filePath: string, value: Record<string, string | undefined>, mode: number): void {
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        descriptor = fs.openSync(
            temporaryPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
            mode
        );
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, mode);
    } catch {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try {
            fs.unlinkSync(temporaryPath);
        } catch {}
        throw new SetupConfigError('write_failed', 'The local setup configuration could not be saved.');
    }
}

export function updateSetupConfig(
    dataDir: string,
    patch: SetupConfigPatch,
    options: { overwrite?: boolean } = {}
): SetupStoredConfig {
    const normalized = normalizePatch(patch);
    ensureDataDirectory(dataDir);
    const current = readSetupConfig(dataDir);
    const next: SetupStoredConfig = {
        settings: mergeWithoutSilentOverwrite(current.settings, normalized.settings, options.overwrite === true),
        credentials: mergeWithoutSilentOverwrite(
            current.credentials,
            normalized.credentials,
            options.overwrite === true
        ),
    };
    const paths = getSetupConfigPaths(dataDir);
    if (Object.keys(normalized.settings).length > 0) writeAtomic(paths.settings, next.settings, 0o600);
    if (Object.keys(normalized.credentials).length > 0) writeAtomic(paths.credentials, next.credentials, 0o600);
    return next;
}

export function resolveSetupEnvironment(
    operatorEnv: NodeJS.ProcessEnv,
    options: { cwd?: string; dataDir?: string } = {}
): NodeJS.ProcessEnv {
    const cwd = options.cwd || process.cwd();
    const dataDir = path.resolve(options.dataDir || operatorEnv.DATA_DIR || path.join(cwd, 'data'));
    const stored = readSetupConfig(dataDir);
    const resolved: NodeJS.ProcessEnv = {
        ...stored.settings,
        ...stored.credentials,
    };
    for (const [key, value] of Object.entries(operatorEnv)) {
        if (value !== undefined) resolved[key] = value;
    }
    return resolved;
}

export function summarizeSetupConfig(config: SetupStoredConfig): {
    settings: SetupSettings;
    credentialsConfigured: SetupCredentialKey[];
} {
    return {
        settings: { ...config.settings },
        credentialsConfigured: SETUP_CREDENTIAL_KEYS.filter((key) => Boolean(config.credentials[key])),
    };
}
