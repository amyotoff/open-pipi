/**
 * The fail-closed rule for exposing the web client.
 *
 * Binding beyond loopback is the moment the assistant becomes reachable by
 * everything else on the network, so it is the moment a way to sign in has to
 * exist. Getting this wrong publishes someone's assistant to their LAN.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfig(env: Record<string, string>) {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...env };
    return await import('../config');
}

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
});

describe('web exposure', () => {
    it('recognizes the loopback names', async () => {
        const config = await loadConfig({});

        expect(config.isLoopbackHost('127.0.0.1')).toBe(true);
        expect(config.isLoopbackHost('localhost')).toBe(true);
        expect(config.isLoopbackHost('::1')).toBe(true);
        expect(config.isLoopbackHost('0.0.0.0')).toBe(false);
        expect(config.isLoopbackHost('192.168.1.20')).toBe(false);
    });

    it('refuses to start when bound to the network with no account', async () => {
        const config = await loadConfig({ PIPI_WEB_ENABLED: 'true', PIPI_WEB_HOST: '0.0.0.0' });

        expect(() => config.assertSafeWebConfig(0)).toThrow(/no web account exists/);
    });

    it('starts once an account exists', async () => {
        const config = await loadConfig({ PIPI_WEB_ENABLED: 'true', PIPI_WEB_HOST: '0.0.0.0' });

        expect(() => config.assertSafeWebConfig(1)).not.toThrow();
    });

    it('allows an accountless loopback bind, which reaches nobody else', async () => {
        const config = await loadConfig({ PIPI_WEB_ENABLED: 'true', PIPI_WEB_HOST: '127.0.0.1' });

        expect(() => config.assertSafeWebConfig(0)).not.toThrow();
    });

    it('says nothing about a web client that is switched off', async () => {
        const config = await loadConfig({ PIPI_WEB_ENABLED: 'false', PIPI_WEB_HOST: '0.0.0.0' });

        expect(() => config.assertSafeWebConfig(0)).not.toThrow();
    });

    it('keeps the web client off unless it is asked for', async () => {
        const config = await loadConfig({});

        expect(config.PIPI_WEB_ENABLED).toBe(false);
        expect(config.PIPI_WEB_HOST).toBe('127.0.0.1');
    });
});
