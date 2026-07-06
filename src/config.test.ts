import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfig(env: Record<string, string | undefined> = {}) {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    return await import('./config');
}

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
});

describe('config', () => {
    describe('isOwner', () => {
        it('should reject arbitrary users by default', async () => {
            const { isOwner } = await loadConfig({
                OWNER_TG_IDS: '',
                BOOTSTRAP_OWNER_MODE: 'false',
            });

            expect(isOwner('111')).toBe(false);
            expect(isOwner('999')).toBe(false);
        });

        it('should allow configured owners only', async () => {
            const { isOwner } = await loadConfig({
                OWNER_TG_IDS: '111,222',
                BOOTSTRAP_OWNER_MODE: 'false',
            });

            expect(isOwner('111')).toBe(true);
            expect(isOwner('222')).toBe(true);
            expect(isOwner('999')).toBe(false);
        });

        it('should allow access only in explicit bootstrap mode', async () => {
            const { isOwner, BOOTSTRAP_OWNER_MODE } = await loadConfig({
                OWNER_TG_IDS: '',
                BOOTSTRAP_OWNER_MODE: 'true',
            });

            expect(BOOTSTRAP_OWNER_MODE).toBe(true);
            expect(isOwner('anyone')).toBe(true);
        });
    });

    describe('assertSafeStartupConfig', () => {
        it('should throw when owners are missing and bootstrap is disabled', async () => {
            const { assertSafeStartupConfig } = await loadConfig({
                OWNER_TG_IDS: '',
                OWNER_IDENTITIES: '',
                BOOTSTRAP_OWNER_MODE: 'false',
            });

            expect(() => assertSafeStartupConfig()).toThrow(/OWNER_TG_IDS.*OWNER_IDENTITIES/i);
        });

        it('should not throw when owners are configured', async () => {
            const { assertSafeStartupConfig } = await loadConfig({
                OWNER_TG_IDS: '111',
                BOOTSTRAP_OWNER_MODE: 'false',
            });

            expect(() => assertSafeStartupConfig()).not.toThrow();
        });

        it('should not throw when channel-qualified owners are configured', async () => {
            const { assertSafeStartupConfig, isOwner } = await loadConfig({
                OWNER_TG_IDS: '',
                OWNER_IDENTITIES: 'whatsapp:+393331234567',
                BOOTSTRAP_OWNER_MODE: 'false',
            });

            expect(() => assertSafeStartupConfig()).not.toThrow();
            expect(isOwner('+393331234567', 'whatsapp')).toBe(true);
        });
    });

    describe('isHouseholdChat', () => {
        it('should return false for empty HOUSEHOLD_CHAT_ID', async () => {
            const { isHouseholdChat } = await loadConfig({ HOUSEHOLD_CHAT_ID: '' });
            expect(isHouseholdChat('12345')).toBe(false);
        });

        it('should return true for matching chat ID', async () => {
            const { isHouseholdChat } = await loadConfig({ HOUSEHOLD_CHAT_ID: '-10042' });
            expect(isHouseholdChat('-10042')).toBe(true);
        });
    });

    describe('validateCriticalConfig', () => {
        it('should throw when env vars are missing', async () => {
            const { validateCriticalConfig } = await loadConfig({
                TELEGRAM_BOT_TOKEN: '',
                GEMINI_API_KEY: '',
            });

            expect(() => validateCriticalConfig()).toThrow(/Unsafe config/);
        });

        it('should not throw when critical tokens are present', async () => {
            const { validateCriticalConfig } = await loadConfig({
                TELEGRAM_BOT_TOKEN: 'test-token',
                GEMINI_API_KEY: 'test-key',
            });

            expect(() => validateCriticalConfig()).not.toThrow();
        });
    });

    describe('exports', () => {
        it('should export all required config values', async () => {
            const config = await loadConfig();
            expect(config.TELEGRAM_BOT_TOKEN).toBeDefined();
            expect(config.GEMINI_API_KEY).toBeDefined();
            expect(config.GEMINI_EXECUTOR_MODEL).toBeDefined();
            expect(config.GEMINI_ADVISOR_MODEL).toBeDefined();
            expect(config.PIPI_ADVISOR_ENABLED).toBeDefined();
            expect(config.PIPI_ADVISOR_MAX_CALLS_PER_TURN).toBeDefined();
            expect(config.OLLAMA_URL).toBeDefined();
            expect(config.OLLAMA_MODEL).toBeDefined();
            expect(config.DATA_DIR).toBeDefined();
            expect(config.DB_PATH).toBeDefined();
            expect(config.LOCATION_LAT).toBeDefined();
            expect(config.LOCATION_LON).toBeDefined();
            expect(config.RUNTIME_PLATFORM).toBeDefined();
        });

        it('should have sensible defaults', async () => {
            const config = await loadConfig({
                GEMINI_EXECUTOR_MODEL: undefined,
                GEMINI_ADVISOR_MODEL: undefined,
                PIPI_ADVISOR_ENABLED: undefined,
                PIPI_ADVISOR_MAX_CALLS_PER_TURN: undefined,
                OLLAMA_URL: undefined,
                OLLAMA_MODEL: undefined,
                BOOTSTRAP_OWNER_MODE: undefined,
            });

            expect(config.GEMINI_EXECUTOR_MODEL).toBe('gemini-2.5-flash');
            expect(config.GEMINI_ADVISOR_MODEL).toBe('gemini-3-pro-preview');
            expect(config.PIPI_ADVISOR_ENABLED).toBe(true);
            expect(config.PIPI_ADVISOR_MAX_CALLS_PER_TURN).toBe(1);
            expect(config.OLLAMA_URL).toBe('http://localhost:11434');
            expect(config.OLLAMA_MODEL).toBe('qwen2.5:1.5b');
            expect(config.BOOTSTRAP_OWNER_MODE).toBe(false);
            expect(config.PIPI_PLATFORM).toBe('auto');
        });
    });

    describe('resolveRuntimePlatform', () => {
        it('should respect explicit raspberry_pi setting', async () => {
            const { resolveRuntimePlatform } = await loadConfig();
            expect(resolveRuntimePlatform('raspberry_pi', 'linux', '')).toBe('raspberry_pi');
        });

        it('should respect explicit generic setting', async () => {
            const { resolveRuntimePlatform } = await loadConfig();
            expect(resolveRuntimePlatform('generic', 'linux', 'Raspberry Pi 5')).toBe('generic');
        });

        it('should auto-detect Raspberry Pi from device model', async () => {
            const { resolveRuntimePlatform } = await loadConfig();
            expect(resolveRuntimePlatform('auto', 'linux', 'Raspberry Pi 5 Model B Rev 1.0')).toBe('raspberry_pi');
        });

        it('should fall back to generic for macOS or unknown hosts', async () => {
            const { resolveRuntimePlatform } = await loadConfig();
            expect(resolveRuntimePlatform('auto', 'darwin', '')).toBe('generic');
            expect(resolveRuntimePlatform('auto', 'linux', '')).toBe('generic');
        });
    });
});
