import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    OptionalChannelDescriptor,
    isDiscordEnabled,
    isGmailEnabled,
    isWhatsAppEnabled,
    loadOptionalChannels,
} from './_loader';

function makeDescriptor(overrides: Partial<OptionalChannelDescriptor>): OptionalChannelDescriptor {
    return {
        type: 'discord',
        label: 'Discord',
        isEnabled: () => true,
        load: vi.fn(async () => ({})),
        packageNames: ['discord.js'],
        ...overrides,
    };
}

describe('channels/_loader', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('skips channels whose enablement predicate is false', async () => {
        const load = vi.fn(async () => ({}));
        await loadOptionalChannels([makeDescriptor({ isEnabled: () => false, load })]);
        expect(load).not.toHaveBeenCalled();
    });

    it('imports every enabled channel', async () => {
        const load = vi.fn(async () => ({}));
        await loadOptionalChannels([makeDescriptor({ load })]);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('raises a setup-oriented error when optional dependencies are missing', async () => {
        const missing = Object.assign(new Error("Cannot find module 'discord.js'"), { code: 'MODULE_NOT_FOUND' });
        const load = vi.fn(async () => {
            throw missing;
        });

        await expect(loadOptionalChannels([makeDescriptor({ load })])).rejects.toThrow(
            /Discord support is enabled by environment.*discord\.js/
        );
    });

    it('rethrows unrelated import-time errors unchanged', async () => {
        const boom = new Error('config exploded');
        const load = vi.fn(async () => {
            throw boom;
        });

        await expect(loadOptionalChannels([makeDescriptor({ load })])).rejects.toBe(boom);
    });

    it('derives enablement from the environment', () => {
        vi.stubEnv('WHATSAPP_ENABLED', 'true');
        vi.stubEnv('DISCORD_BOT_TOKEN', 'token');
        vi.stubEnv('DISCORD_CHANNEL_ID', '');
        vi.stubEnv('CONCIERGE_SMTP_HOST', 'smtp.example.test');
        vi.stubEnv('CONCIERGE_SMTP_USER', 'bot@example.test');

        expect(isWhatsAppEnabled()).toBe(true);
        expect(isDiscordEnabled()).toBe(false); // needs both token and channel id
        expect(isGmailEnabled()).toBe(true);
    });
});
