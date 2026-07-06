/**
 * Discord channel — outbound notifications plus inbound chat for the primary
 * configured channel and direct messages.
 *
 * Self-registers when DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are set.
 */

import {
    ChannelType as DiscordChannelType,
    Client,
    GatewayIntentBits,
    Message,
    Partials,
    TextChannel,
} from 'discord.js';
import { OutboundChannel, SendResult, MessageOptions } from './_types';
import { registerChannel } from './_registry';
import { dispatchIncomingChannelMessage } from './runtime';
import { executeChannelCommand } from '../core/channel-commands';

export class DiscordChannel implements OutboundChannel {
    readonly type = 'discord' as const;
    private client: Client;
    private channelId: string;
    private connected = false;

    constructor() {
        this.channelId = process.env.DISCORD_CHANNEL_ID || '';
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.MessageContent,
            ],
            partials: [Partials.Channel],
        });
    }

    async connect(): Promise<void> {
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!token) throw new Error('DISCORD_BOT_TOKEN not set');
        if (!this.channelId) throw new Error('DISCORD_CHANNEL_ID not set');

        this.client.on('messageCreate', (message) => {
            void this.handleInboundMessage(message);
        });

        await this.client.login(token);

        await new Promise<void>((resolve) => {
            this.client.once('ready', () => {
                this.connected = true;
                console.log(`[DISCORD] Logged in as ${this.client.user?.tag}`);
                resolve();
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected && this.client.isReady();
    }

    async sendMessage(to: string, text: string, _opts?: MessageOptions): Promise<SendResult> {
        // `to` can be a channel ID override, a DM channel ID, or the default channel.
        const targetId = to || this.channelId;

        if (!this.isConnected()) {
            return { success: false, error: 'Discord not connected' };
        }

        try {
            const channel = await this.client.channels.fetch(targetId);
            if (!channel || !channel.isTextBased()) {
                const user = await this.client.users.fetch(targetId).catch(() => null);
                if (!user) {
                    return { success: false, error: `Channel or user ${targetId} not found` };
                }

                const dm = await user.createDM();
                const sent = await dm.send(text);
                return { success: true, messageId: sent.id };
            }

            const sent = await (channel as TextChannel).send(text);
            return { success: true, messageId: sent.id };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async handleInboundMessage(message: Message): Promise<void> {
        if (message.author?.bot || !message.content?.trim()) return;

        const isDirect = message.channel.type === DiscordChannelType.DM;
        const isPrimaryGroup = !isDirect && message.channelId === this.channelId;
        if (!isDirect && !isPrimaryGroup) return;

        const text = message.content.trim();

        if (text.toLowerCase().startsWith('/artifacts')) {
            const handlers = require('../skills/_registry').getRegisteredHandlers();
            const context = { chatId: message.channelId, userId: message.author.id };
            const parts = text.split(/\s+/).slice(1);

            let result: string;
            if (parts.length === 0) {
                result = handlers.artifacts_list
                    ? await handlers.artifacts_list({}, context)
                    : '[TOOL_RESULT] Artifact management is not available.';
            } else {
                result = `[TOOL_RESULT] Usage:\n/artifacts`;
            }
            await this.replyInPlace(message, result.replace('[TOOL_RESULT] ', ''));
            return;
        }

        const handledCommand = await executeChannelCommand({
            channel: 'discord',
            channelRef: message.channelId,
            senderId: message.author.id,
            senderUsername: message.author.username,
            senderDisplayName: message.member?.displayName || message.author.globalName || message.author.username,
            isDirect,
            rawText: text,
            reply: async (responseText: string) => {
                await this.replyInPlace(message, responseText);
            },
            sendTyping: async () => {
                if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
                    await message.channel.sendTyping();
                }
            },
        });
        if (handledCommand) return;

        let replyTo:
            | {
                  senderId?: string | null;
                  senderUsername?: string | null;
                  senderDisplayName?: string | null;
                  isBot?: boolean;
                  text?: string | null;
              }
            | undefined;

        if (message.reference?.messageId) {
            try {
                const referenced = await message.fetchReference();
                replyTo = {
                    senderId: referenced.author?.id || null,
                    senderUsername: referenced.author?.username || null,
                    senderDisplayName:
                        referenced.member?.displayName ||
                        referenced.author?.globalName ||
                        referenced.author?.username ||
                        null,
                    isBot: referenced.author?.bot || false,
                    text: referenced.content || null,
                };
            } catch (error: any) {
                console.warn(`[DISCORD] Failed to resolve reply context: ${error.message}`);
            }
        }

        await dispatchIncomingChannelMessage({
            channel: 'discord',
            channelRef: message.channelId,
            senderId: message.author.id,
            senderUsername: message.author.username,
            senderDisplayName: message.member?.displayName || message.author.globalName || message.author.username,
            messageId: message.id,
            text,
            isDirect,
            isPrimaryGroup,
            botUsername: this.client.user?.username || null,
            botUserId: this.client.user?.id || null,
            replyTo,
            respond: async (responseText: string) => {
                await this.replyInPlace(message, responseText);
            },
        });
    }

    private async replyInPlace(message: Message, text: string): Promise<void> {
        await message.reply({
            content: text,
            allowedMentions: { repliedUser: false },
        });
    }
}

// ==========================================
// Self-registration
// ==========================================

if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID) {
    registerChannel('discord', () => new DiscordChannel());
}
