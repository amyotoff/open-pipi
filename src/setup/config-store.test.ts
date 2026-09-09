import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    SetupConfigError,
    getSetupConfigPaths,
    loadOperatorEnvironment,
    readSetupConfig,
    resolveSetupEnvironment,
    summarizeSetupConfig,
    updateSetupConfig,
} from './config-store';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-config-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('setup config store', () => {
    it('loads an injected operator env file below explicitly exported values', () => {
        const readEnvFile = (filePath: string) => {
            expect(filePath).toBe('/repo/.env');
            return 'LLM_PROVIDER=openrouter\nOPENROUTER_API_KEY=file-secret\nTZ=Europe/Rome\n';
        };

        expect(
            loadOperatorEnvironment('/repo', { OPENROUTER_API_KEY: 'exported-secret', TZ: undefined }, readEnvFile)
        ).toEqual({
            LLM_PROVIDER: 'openrouter',
            OPENROUTER_API_KEY: 'exported-secret',
            TZ: 'Europe/Rome',
        });
        expect(() =>
            loadOperatorEnvironment('/repo', {}, () => {
                throw new Error('private path');
            })
        ).toThrowError(expect.objectContaining({ code: 'operator_env_invalid' }));
    });

    it('stores settings separately from private credentials and returns a redacted summary', () => {
        const dataDir = temporaryDirectory();
        const saved = updateSetupConfig(dataDir, {
            settings: {
                LLM_PROVIDER: 'openrouter',
                LLM_TOOLS_PROVIDER: 'openrouter',
                BOOTSTRAP_PACK: 'jeeves',
                OWNER_TG_IDS: '123456',
            },
            credentials: {
                OPENROUTER_API_KEY: 'sk-or-private',
                TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCD',
            },
        });

        expect(readSetupConfig(dataDir)).toEqual(saved);
        expect(summarizeSetupConfig(saved)).toEqual({
            settings: saved.settings,
            credentialsConfigured: ['TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY'],
        });
        const paths = getSetupConfigPaths(dataDir);
        expect(fs.readFileSync(paths.settings, 'utf8')).not.toContain('sk-or-private');
        expect(fs.readFileSync(paths.credentials, 'utf8')).not.toContain('OWNER_TG_IDS');
        expect(fs.statSync(paths.credentials).mode & 0o777).toBe(0o600);
    });

    it('is idempotent while refusing to replace an existing choice without an explicit overwrite', () => {
        const dataDir = temporaryDirectory();
        updateSetupConfig(dataDir, { settings: { BOOTSTRAP_PACK: 'jeeves' } });

        expect(() => updateSetupConfig(dataDir, { settings: { BOOTSTRAP_PACK: 'jeeves' } })).not.toThrow();
        expect(() => updateSetupConfig(dataDir, { settings: { BOOTSTRAP_PACK: 'other' } })).toThrowError(
            expect.objectContaining({ code: 'already_configured' })
        );

        expect(
            updateSetupConfig(dataDir, { settings: { BOOTSTRAP_PACK: 'other' } }, { overwrite: true }).settings
                .BOOTSTRAP_PACK
        ).toBe('other');
    });

    it('lets explicit operator values take precedence over locally stored setup values', () => {
        const dataDir = temporaryDirectory();
        updateSetupConfig(dataDir, {
            settings: { LLM_PROVIDER: 'openrouter', LLM_TOOLS_PROVIDER: 'openrouter', TZ: 'Europe/Rome' },
            credentials: { OPENROUTER_API_KEY: 'stored-secret' },
        });

        const resolved = resolveSetupEnvironment(
            { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'operator-secret' },
            { dataDir }
        );

        expect(resolved).toMatchObject({
            LLM_PROVIDER: 'anthropic',
            ANTHROPIC_API_KEY: 'operator-secret',
            OPENROUTER_API_KEY: 'stored-secret',
            LLM_TOOLS_PROVIDER: 'openrouter',
            TZ: 'Europe/Rome',
        });
    });

    it('rejects unknown keys, malformed values, and corrupt files without echoing contents', () => {
        const dataDir = temporaryDirectory();
        expect(() => updateSetupConfig(dataDir, { settings: { UNKNOWN: 'value' } as never })).toThrowError(
            SetupConfigError
        );
        expect(() => updateSetupConfig(dataDir, { credentials: { TELEGRAM_BOT_TOKEN: 'secret' } })).toThrowError(
            expect.objectContaining({ code: 'invalid_value' })
        );

        const paths = getSetupConfigPaths(dataDir);
        fs.writeFileSync(paths.credentials, '{"OPENROUTER_API_KEY":"very-private",', { mode: 0o600 });
        let thrown: unknown;
        try {
            readSetupConfig(dataDir);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'corrupt_file' });
        expect(String(thrown)).not.toContain('very-private');
    });

    it('refuses symlinked configuration files', () => {
        const dataDir = temporaryDirectory();
        const target = path.join(dataDir, 'target.json');
        fs.writeFileSync(target, '{}');
        fs.symlinkSync(target, getSetupConfigPaths(dataDir).settings);

        expect(() => readSetupConfig(dataDir)).toThrowError(expect.objectContaining({ code: 'unsafe_file' }));
    });

    it('refuses to read credentials exposed to group or other users', () => {
        const dataDir = temporaryDirectory();
        const credentialsPath = getSetupConfigPaths(dataDir).credentials;
        fs.writeFileSync(credentialsPath, '{"OPENROUTER_API_KEY":"stored-secret"}', { mode: 0o644 });
        fs.chmodSync(credentialsPath, 0o644);

        expect(() => readSetupConfig(dataDir)).toThrowError(expect.objectContaining({ code: 'unsafe_file' }));
    });
});
