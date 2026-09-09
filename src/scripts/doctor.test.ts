import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateSetupConfig } from '../setup/config-store';
import {
    formatDoctorReport,
    inspectDoctor,
    isDoctorCli,
    loadDoctorInput,
    type DoctorIO,
    type DoctorInput,
} from './doctor';

const cwd = path.resolve('/repo');
const packPath = path.join(cwd, 'src', 'packs', 'jeeves', 'agent.md');
const groundingPath = path.join(cwd, 'src', 'groundings', 'jeeves_personal', 'grounding.md');
const dataPath = path.join(cwd, 'data');

function buildInput(overrides: Partial<DoctorInput['env']> = {}): DoctorInput {
    return {
        cwd,
        nodeVersion: '24.4.0',
        envFileFound: true,
        env: {
            TELEGRAM_BOT_TOKEN: '123456:real-token',
            OPENROUTER_API_KEY: 'real-openrouter-key',
            OWNER_TG_IDS: '123456',
            BOOTSTRAP_OWNER_MODE: 'false',
            BOOTSTRAP_PACK: 'jeeves',
            BOOTSTRAP_GROUNDING: 'jeeves_personal',
            DATA_DIR: './data',
            TZ: 'Europe/Podgorica',
            ...overrides,
        },
    };
}

function buildIO(overrides: Partial<DoctorIO> = {}): DoctorIO {
    const existing = new Set([cwd, packPath, groundingPath, dataPath]);
    return {
        exists: (targetPath) => existing.has(targetPath),
        isDirectory: (targetPath) => targetPath === cwd || targetPath === dataPath,
        isWritable: () => true,
        canResolvePackage: () => true,
        ...overrides,
    };
}

describe('Open PiPi doctor', () => {
    it('recognizes direct ts-node execution without relying only on require.main', () => {
        expect(isDoctorCli('/repo/src/scripts/doctor.ts', '/repo/src/scripts/doctor.ts')).toBe(true);
        expect(isDoctorCli('/repo/node_modules/vitest.mjs', '/repo/src/scripts/doctor.ts')).toBe(false);
    });

    it('reports a minimal configured Telegram installation as ready', () => {
        const checks = inspectDoctor(buildInput(), buildIO());

        expect(checks.some((item) => item.status === 'fail')).toBe(false);
        expect(checks.filter((item) => item.status === 'warn').map((item) => item.id)).toEqual([
            'llm-tools-key',
            'llm-vision-key',
            'llm-search-key',
        ]);
        expect(formatDoctorReport(checks)).toContain('Ready to start (3 warnings).');
        expect(formatDoctorReport(checks)).toContain('Next: pnpm dev');
    });

    it('keeps an OpenRouter-only text install ready while warning about unconfigured native capabilities', () => {
        const checks = inspectDoctor(buildInput(), buildIO());

        expect(checks.find((item) => item.id === 'llm-key')).toMatchObject({ status: 'pass' });
        for (const id of ['llm-tools-key', 'llm-vision-key', 'llm-search-key']) {
            expect(checks.find((item) => item.id === id)).toMatchObject({ status: 'warn' });
            expect(checks.find((item) => item.id === id)?.message).toContain('GEMINI_API_KEY');
        }
    });

    it('loads the same local setup configuration as runtime without exposing credentials', () => {
        const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-doctor-'));
        const dataDir = path.join(testRoot, 'private-data');
        const previousDataDir = process.env.DATA_DIR;
        const previousToolsProvider = process.env.LLM_TOOLS_PROVIDER;
        const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
        try {
            updateSetupConfig(dataDir, {
                settings: { LLM_TOOLS_PROVIDER: 'openrouter' },
                credentials: { OPENROUTER_API_KEY: 'stored-private-key' },
            });
            process.env.DATA_DIR = dataDir;
            delete process.env.LLM_TOOLS_PROVIDER;
            delete process.env.OPENROUTER_API_KEY;

            const input = loadDoctorInput(testRoot);
            expect(input.localConfigFound).toBe(true);
            expect(input.localConfigError).toBe(false);
            expect(input.env).toMatchObject({
                LLM_TOOLS_PROVIDER: 'openrouter',
                OPENROUTER_API_KEY: 'stored-private-key',
            });
            const localCheck = inspectDoctor(input, buildIO()).find((item) => item.id === 'local-config');
            expect(JSON.stringify(localCheck)).not.toContain('stored-private-key');
            expect(inspectDoctor(input, buildIO()).find((item) => item.id === 'env-file')).toMatchObject({
                status: 'pass',
                message: 'Using local setup configuration and exported overrides.',
            });
        } finally {
            if (previousDataDir === undefined) delete process.env.DATA_DIR;
            else process.env.DATA_DIR = previousDataDir;
            if (previousToolsProvider === undefined) delete process.env.LLM_TOOLS_PROVIDER;
            else process.env.LLM_TOOLS_PROVIDER = previousToolsProvider;
            if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
            else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
            fs.rmSync(testRoot, { recursive: true, force: true });
        }
    });

    it('clears every optional capability warning once its selected native key is configured', () => {
        const checks = inspectDoctor(buildInput({ GEMINI_API_KEY: 'real-gemini-key' }), buildIO());

        expect(checks.every((item) => item.status === 'pass')).toBe(true);
        expect(checks.filter((item) => item.id.startsWith('llm-')).map((item) => item.id)).toEqual([
            'llm-key',
            'llm-tools-key',
            'llm-vision-key',
            'llm-search-key',
        ]);
    });

    it('fails safely for missing secrets and never prints their values', () => {
        const input = buildInput({ TELEGRAM_BOT_TOKEN: '...', OPENROUTER_API_KEY: '<your-key>', OWNER_TG_IDS: '' });
        const checks = inspectDoctor(input, buildIO());
        const report = formatDoctorReport(checks);

        expect(checks.filter((item) => item.status === 'fail').map((item) => item.id)).toEqual([
            'telegram-token',
            'llm-key',
            'owner',
        ]);
        expect(report).not.toContain('123456:real-token');
        expect(report).not.toContain('<your-key>');
        expect(report).toContain('Not ready: 3 checks failed.');
    });

    it('warns about temporary bootstrap access and accepts a creatable data directory', () => {
        const input = {
            ...buildInput({ OWNER_TG_IDS: '', BOOTSTRAP_OWNER_MODE: 'true', DATA_DIR: './fresh/data' }),
            envFileFound: false,
        };
        const io = buildIO({
            exists: (targetPath) => [cwd, packPath, groundingPath].includes(targetPath),
            isDirectory: (targetPath) => targetPath === cwd,
        });
        const checks = inspectDoctor(input, io);

        expect(checks.find((item) => item.id === 'env-file')?.status).toBe('warn');
        expect(checks.find((item) => item.id === 'owner')?.status).toBe('warn');
        expect(checks.find((item) => item.id === 'data-dir')?.status).toBe('pass');
        expect(checks.some((item) => item.status === 'fail')).toBe(false);
    });

    it('detects invalid local assets and partial optional channel configuration', () => {
        const input = buildInput({
            BOOTSTRAP_PACK: '../private',
            TZ: 'Mars/Olympus',
            DISCORD_BOT_TOKEN: 'token-only',
            CONCIERGE_SMTP_HOST: 'smtp.example.test',
            PIPI_API_PORT: '8080',
        });
        const checks = inspectDoctor(input, buildIO());

        expect(checks.find((item) => item.id === 'pack')?.status).toBe('fail');
        expect(checks.find((item) => item.id === 'timezone')?.status).toBe('fail');
        expect(checks.find((item) => item.id === 'discord')?.status).toBe('fail');
        expect(checks.find((item) => item.id === 'gmail')?.status).toBe('fail');
        expect(checks.find((item) => item.id === 'api')?.message).toContain('PIPI_API_TOKEN');
    });

    it('fails cleanly when the env file is unreadable', () => {
        const checks = inspectDoctor({ ...buildInput(), envFileError: true }, buildIO());

        expect(checks.find((item) => item.id === 'env-file')).toMatchObject({ status: 'fail' });
        expect(formatDoctorReport(checks)).toContain('.env exists but could not be read.');
    });

    it('reports missing packages only for enabled optional channels', () => {
        const input = buildInput({
            WHATSAPP_ENABLED: 'true',
            DISCORD_BOT_TOKEN: 'token',
            DISCORD_CHANNEL_ID: 'channel',
        });
        const io = buildIO({ canResolvePackage: (packageName) => packageName === '@hapi/boom' });
        const checks = inspectDoctor(input, io);

        expect(checks.find((item) => item.id === 'whatsapp')?.message).toContain('@whiskeysockets/baileys');
        expect(checks.find((item) => item.id === 'discord')?.message).toContain('discord.js');
        expect(checks.some((item) => item.id === 'gmail')).toBe(false);
    });

    it('validates Home Assistant without exposing its token', () => {
        const configured = inspectDoctor(
            buildInput({
                HOME_ASSISTANT_URL: 'http://127.0.0.1:8123',
                HOME_ASSISTANT_TOKEN: 'private-ha-token',
                HOME_ASSISTANT_READ_ENTITIES: 'sensor.hall_temperature',
                HOME_ASSISTANT_CONTROL_ENTITIES: 'light.kitchen,switch.coffee',
            }),
            buildIO()
        );
        const check = configured.find((item) => item.id === 'home-assistant');

        expect(check).toMatchObject({ status: 'pass' });
        expect(check?.message).toContain('3 exact entities');
        expect(JSON.stringify(check)).not.toContain('private-ha-token');

        const unsafe = inspectDoctor(
            buildInput({
                HOME_ASSISTANT_TOKEN: 'private-ha-token',
                HOME_ASSISTANT_CONTROL_ENTITIES: 'lock.front_door',
            }),
            buildIO()
        );
        expect(unsafe.find((item) => item.id === 'home-assistant')).toMatchObject({ status: 'fail' });
    });

    it('keeps the optional Home Assistant addon dormant until a token or allowlist is configured', () => {
        const checks = inspectDoctor(
            buildInput({
                HOME_ASSISTANT_URL: 'http://127.0.0.1:8123',
                HOME_ASSISTANT_TIMEOUT_MS: '5000',
                HOME_ASSISTANT_TOKEN: '',
                HOME_ASSISTANT_READ_ENTITIES: '',
                HOME_ASSISTANT_CONTROL_ENTITIES: '',
            }),
            buildIO()
        );

        expect(checks.some((item) => item.id === 'home-assistant')).toBe(false);
    });

    it('warns for token-only setup and fails an allowlist without a token', () => {
        const tokenOnly = inspectDoctor(buildInput({ HOME_ASSISTANT_TOKEN: 'private-ha-token' }), buildIO());
        expect(tokenOnly.find((item) => item.id === 'home-assistant')).toMatchObject({ status: 'warn' });

        const allowlistOnly = inspectDoctor(
            buildInput({ HOME_ASSISTANT_CONTROL_ENTITIES: 'light.kitchen' }),
            buildIO()
        );
        expect(allowlistOnly.find((item) => item.id === 'home-assistant')).toMatchObject({ status: 'fail' });
    });
});
