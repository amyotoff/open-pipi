import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ quiet: true });

function readBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (!raw) return fallback;

    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const PIPI_PUBLIC_BASE_URL = (process.env.PIPI_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const OPEN_PIPI_DB_PATH = path.join(DATA_DIR, 'open-pipi.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'pipi.db');
export const DB_PATH =
    process.env.DB_PATH ||
    (fs.existsSync(OPEN_PIPI_DB_PATH)
        ? OPEN_PIPI_DB_PATH
        : fs.existsSync(LEGACY_DB_PATH)
          ? LEGACY_DB_PATH
          : OPEN_PIPI_DB_PATH);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_EXECUTOR_MODEL = process.env.GEMINI_EXECUTOR_MODEL || 'gemini-2.5-flash';
export const GEMINI_ADVISOR_MODEL = process.env.GEMINI_ADVISOR_MODEL || 'gemini-3-pro-preview';
export const PIPI_ADVISOR_ENABLED = readBooleanEnv('PIPI_ADVISOR_ENABLED', true);
export const PIPI_ADVISOR_MAX_CALLS_PER_TURN = readPositiveIntEnv('PIPI_ADVISOR_MAX_CALLS_PER_TURN', 1);
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
export const HOUSEHOLD_CHAT_ID = process.env.HOUSEHOLD_CHAT_ID || '';
export const BOOTSTRAP_OWNER_MODE = process.env.BOOTSTRAP_OWNER_MODE === 'true';
export type PlatformSetting = 'auto' | 'raspberry_pi' | 'generic';
export type RuntimePlatform = 'raspberry_pi' | 'generic';

export function resolveRuntimePlatform(
    setting: string | undefined,
    nodePlatform: NodeJS.Platform = process.platform,
    deviceModel?: string
): RuntimePlatform {
    if (setting === 'raspberry_pi') return 'raspberry_pi';
    if (setting === 'generic') return 'generic';

    const model = (deviceModel || '').toLowerCase();
    if (model.includes('raspberry pi')) return 'raspberry_pi';

    if (nodePlatform === 'darwin') return 'generic';
    return 'generic';
}

export const PIPI_PLATFORM: PlatformSetting =
    process.env.PIPI_PLATFORM === 'raspberry_pi' || process.env.PIPI_PLATFORM === 'generic'
        ? process.env.PIPI_PLATFORM
        : 'auto';

function readDeviceModel(): string {
    const candidates = ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model'];

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return fs.readFileSync(candidate, 'utf-8').replace(/\0/g, '').trim();
            }
        } catch {}
    }

    return '';
}

export const RUNTIME_PLATFORM: RuntimePlatform = resolveRuntimePlatform(
    PIPI_PLATFORM,
    process.platform,
    readDeviceModel()
);

// Weather (Open-Meteo)
export const LOCATION_LAT = process.env.LOCATION_LAT || '0.0000';
export const LOCATION_LON = process.env.LOCATION_LON || '0.0000';

// Access Control — who can use the bot
export const OWNER_TG_IDS: Set<string> = new Set(
    (process.env.OWNER_TG_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

export const OWNER_IDENTITIES: Set<string> = new Set(
    (process.env.OWNER_IDENTITIES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

export function buildOwnerIdentity(channel: string, userId: string): string {
    return `${channel}:${userId}`;
}

export function isOwner(userId: string, channel: string = 'telegram'): boolean {
    return (
        BOOTSTRAP_OWNER_MODE ||
        (channel === 'telegram' && OWNER_TG_IDS.has(userId)) ||
        OWNER_IDENTITIES.has(buildOwnerIdentity(channel, userId))
    );
}

export function validateCriticalConfig(): void {
    const errors: string[] = [];

    if (!TELEGRAM_BOT_TOKEN) errors.push('TELEGRAM_BOT_TOKEN is not set');
    if (!GEMINI_API_KEY) errors.push('GEMINI_API_KEY is not set');

    if (errors.length > 0) {
        console.error('[SECURITY] Critical config errors:\n' + errors.map((entry) => `- ${entry}`).join('\n'));
        throw new Error(`Unsafe config: ${errors.join('; ')}`);
    }
}

export function assertSafeStartupConfig(): void {
    const problems: string[] = [];

    if (OWNER_TG_IDS.size === 0 && OWNER_IDENTITIES.size === 0 && !BOOTSTRAP_OWNER_MODE) {
        problems.push(
            'OWNER_TG_IDS and OWNER_IDENTITIES are empty. Refusing to start in fail-open mode. Set at least one owner list or explicitly enable BOOTSTRAP_OWNER_MODE=true for first-time setup.'
        );
    }

    if (problems.length > 0) {
        console.error('[SECURITY] Unsafe startup configuration detected:\n' + problems.map((p) => `- ${p}`).join('\n'));
        throw new Error(problems.join('\n'));
    }

    if (BOOTSTRAP_OWNER_MODE) {
        console.warn(
            '[SECURITY] BOOTSTRAP_OWNER_MODE=true. Access control is temporarily open for initial setup only.'
        );
    }
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function isHouseholdChat(chatId: string): boolean {
    return !!HOUSEHOLD_CHAT_ID && chatId.toString() === HOUSEHOLD_CHAT_ID;
}
