/**
 * Optional channel loader — declarative descriptors for channels whose npm
 * dependencies are optional (WhatsApp, Discord, Gmail).
 *
 * Each descriptor pairs an enablement predicate with a static import thunk,
 * so TypeScript verifies the module path and the enablement condition lives
 * in one place: the channel module reuses the same predicate for its
 * self-registration guard.
 */

import type { ChannelType } from './_types';

export type OptionalChannelDescriptor = {
    type: ChannelType;
    label: string;
    /** Single source of truth for "is this channel configured?". */
    isEnabled: () => boolean;
    /** Import thunk (not a path string) so a renamed module fails typecheck, not startup. */
    load: () => Promise<unknown>;
    /** Optional npm packages the module needs; named in the error when missing. */
    packageNames: string[];
};

export function isWhatsAppEnabled(): boolean {
    return process.env.WHATSAPP_ENABLED === 'true';
}

export function isDiscordEnabled(): boolean {
    return Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID);
}

export function isGmailEnabled(): boolean {
    return Boolean(process.env.CONCIERGE_SMTP_HOST && process.env.CONCIERGE_SMTP_USER);
}

export const OPTIONAL_CHANNELS: OptionalChannelDescriptor[] = [
    {
        type: 'whatsapp',
        label: 'WhatsApp',
        isEnabled: isWhatsAppEnabled,
        load: () => import('./whatsapp'),
        packageNames: ['@whiskeysockets/baileys', '@hapi/boom'],
    },
    {
        type: 'discord',
        label: 'Discord',
        isEnabled: isDiscordEnabled,
        load: () => import('./discord'),
        packageNames: ['discord.js'],
    },
    {
        type: 'gmail',
        label: 'Gmail',
        isEnabled: isGmailEnabled,
        load: () => import('./gmail'),
        packageNames: ['nodemailer'],
    },
];

export function isMissingOptionalDependency(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
    return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * Import every enabled optional channel so it self-registers with _registry.
 * Throws a setup-oriented error when an optional npm dependency is missing.
 */
export async function loadOptionalChannels(channels: OptionalChannelDescriptor[] = OPTIONAL_CHANNELS): Promise<void> {
    for (const channel of channels) {
        if (!channel.isEnabled()) continue;

        try {
            await channel.load();
        } catch (error) {
            if (isMissingOptionalDependency(error)) {
                const packageList = channel.packageNames.join(', ');
                throw new Error(
                    `${channel.label} support is enabled by environment, but optional dependencies are missing: ${packageList}. Run "pnpm install" without "--no-optional", or add those packages explicitly.`,
                    { cause: error }
                );
            }
            throw error;
        }
    }
}
