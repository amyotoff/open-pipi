/**
 * Channel registry — factory pattern with self-registration.
 *
 * Each channel module calls registerChannel() at import time.
 * The registry lazily instantiates channels on first getChannel() call.
 */

import { OutboundChannel, ChannelType, ChannelFactory } from './_types';

const factories = new Map<ChannelType, ChannelFactory>();
const instances = new Map<ChannelType, OutboundChannel>();

/**
 * Register a channel factory. Called by channel modules at import time.
 * If a channel's env vars are missing, the factory should return null.
 */
export function registerChannel(type: ChannelType, factory: ChannelFactory): void {
    factories.set(type, factory);
}

/**
 * Get a channel instance by type. Lazily instantiates from factory.
 * Returns null if not registered or factory returned null (not configured).
 */
export function getChannel(type: ChannelType): OutboundChannel | null {
    if (instances.has(type)) return instances.get(type)!;

    const factory = factories.get(type);
    if (!factory) return null;

    const instance = factory();
    if (!instance) return null;

    instances.set(type, instance);
    return instance;
}

/** Get all registered and instantiated channels */
export function getAllChannels(): OutboundChannel[] {
    return Array.from(instances.values());
}

/** Get all registered channel types (including not yet instantiated) */
export function getRegisteredTypes(): ChannelType[] {
    return Array.from(factories.keys());
}

/**
 * Connect all registered channels. Logs warnings for channels that fail to connect.
 * Called from bootstrap in index.ts after skill initialization.
 */
export async function connectAll(): Promise<void> {
    for (const type of factories.keys()) {
        const channel = getChannel(type);
        if (!channel) {
            console.log(`[CHANNELS] ${type}: not configured, skipping`);
            continue;
        }
        try {
            await channel.connect();
            console.log(`[CHANNELS] ${type}: connected`);
        } catch (err: any) {
            console.warn(`[CHANNELS] ${type}: failed to connect — ${err.message}`);
        }
    }
}

/** Gracefully disconnect all connected channels */
export async function disconnectAll(): Promise<void> {
    for (const [type, channel] of instances) {
        try {
            await channel.disconnect();
            console.log(`[CHANNELS] ${type}: disconnected`);
        } catch (err: any) {
            console.warn(`[CHANNELS] ${type}: disconnect error — ${err.message}`);
        }
    }
    instances.clear();
}
