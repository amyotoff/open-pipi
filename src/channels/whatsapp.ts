/**
 * WhatsApp channel via Baileys (native WhatsApp Web protocol).
 *
 * Self-registers when WHATSAPP_ENABLED=true.
 * Auth credentials stored in DATA_DIR/whatsapp-auth/.
 * No browser needed — saves ~200-400MB RAM vs Playwright on RPi4.
 */

import makeWASocket, { useMultiFileAuthState, DisconnectReason, WASocket } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import { dispatchIncomingChannelMessage, IncomingChannelMessage } from './runtime';
import { OutboundChannel, SendResult, MessageOptions } from './_types';
import { registerChannel } from './_registry';
import { DATA_DIR } from '../config';
import { executeChannelCommand } from '../core/channel-commands';

const AUTH_DIR = path.join(DATA_DIR, 'whatsapp-auth');
const MESSAGE_DEDUPE_TTL_MS = 15 * 60 * 1000;
const MESSAGE_DEDUPE_LIMIT = 1024;

function normalizePhoneDigits(value: string): string {
    return value.replace(/[^0-9]/g, '');
}

function normalizeWhatsAppAddress(value: string): string {
    return value.replace(/@.*$/, '').split(':')[0];
}

export function isWhatsAppGroupJid(jid: string): boolean {
    return jid.endsWith('@g.us');
}

function isWhatsAppUserJid(jid: string): boolean {
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us');
}

/** Convert phone number (+39 06 1234567) to WhatsApp JID (3906123456@s.whatsapp.net) */
export function phoneToJid(phone: string): string {
    if (/@(s\.whatsapp\.net|c\.us|g\.us)$/.test(phone)) {
        return phone;
    }

    const digits = normalizePhoneDigits(phone);
    return `${digits}@s.whatsapp.net`;
}

/** Convert WhatsApp JID to phone number */
export function jidToPhone(jid: string): string {
    const digits = normalizePhoneDigits(normalizeWhatsAppAddress(jid));
    return digits ? `+${digits}` : '';
}

export function normalizeWhatsAppChannelRef(jid: string): string {
    return isWhatsAppGroupJid(jid) ? jid : jidToPhone(jid);
}

export function resolveWhatsAppSendTarget(target: string): string {
    return isWhatsAppGroupJid(target) ? target : phoneToJid(target);
}

function unwrapMessageContent(message?: proto.IMessage | null): proto.IMessage | null | undefined {
    let current = message;

    while (current) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            continue;
        }
        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            continue;
        }
        if (current.documentWithCaptionMessage?.message) {
            current = current.documentWithCaptionMessage.message;
            continue;
        }
        break;
    }

    return current;
}

export function extractWhatsAppText(message?: proto.IMessage | null): string {
    const content = unwrapMessageContent(message);
    return (
        content?.conversation ||
        content?.extendedTextMessage?.text ||
        content?.imageMessage?.caption ||
        content?.videoMessage?.caption ||
        content?.documentMessage?.caption ||
        ''
    ).trim();
}

function extractReplyContext(message?: proto.IMessage | null): IncomingChannelMessage['replyTo'] | undefined {
    const content = unwrapMessageContent(message);
    const contextInfo =
        content?.extendedTextMessage?.contextInfo ||
        content?.imageMessage?.contextInfo ||
        content?.videoMessage?.contextInfo ||
        content?.documentMessage?.contextInfo;

    if (!contextInfo?.quotedMessage) return undefined;

    const senderId = contextInfo.participant ? jidToPhone(contextInfo.participant) : null;
    return {
        senderId,
        senderDisplayName: senderId,
        text: extractWhatsAppText(contextInfo.quotedMessage),
    };
}

export function buildWhatsAppInboundMessage(args: {
    message: proto.IWebMessageInfo;
    primaryGroupJid?: string;
    botUserId?: string | null;
}): IncomingChannelMessage | null {
    const { message, primaryGroupJid, botUserId } = args;
    const remoteJid = message.key?.remoteJid;
    const messageId = message.key?.id;

    if (!remoteJid || !messageId || message.key?.fromMe) return null;

    const isGroup = isWhatsAppGroupJid(remoteJid);
    if (isGroup) {
        if (!primaryGroupJid || remoteJid !== primaryGroupJid) return null;
    } else if (!isWhatsAppUserJid(remoteJid)) {
        return null;
    }

    const text = extractWhatsAppText(message.message);
    if (!text) return null;

    const senderJid = isGroup
        ? message.key?.participant ||
          message.participant ||
          message.message?.extendedTextMessage?.contextInfo?.participant ||
          ''
        : remoteJid;
    const senderId = jidToPhone(senderJid);
    if (!senderId) return null;

    return {
        channel: 'whatsapp',
        channelRef: normalizeWhatsAppChannelRef(remoteJid),
        senderId,
        senderDisplayName: message.pushName || senderId,
        messageId,
        text,
        isDirect: !isGroup,
        isPrimaryGroup: isGroup,
        botUserId: botUserId || null,
        replyTo: extractReplyContext(message.message),
    };
}

export function rememberProcessedWhatsAppMessage(
    processedIds: Map<string, number>,
    messageId: string,
    now: number = Date.now()
): boolean {
    for (const [knownId, timestamp] of processedIds) {
        if (now - timestamp > MESSAGE_DEDUPE_TTL_MS) {
            processedIds.delete(knownId);
        }
    }

    if (processedIds.has(messageId)) {
        return false;
    }

    processedIds.set(messageId, now);
    while (processedIds.size > MESSAGE_DEDUPE_LIMIT) {
        const oldest = processedIds.keys().next().value;
        if (!oldest) break;
        processedIds.delete(oldest);
    }

    return true;
}

class WhatsAppChannel implements OutboundChannel {
    readonly type = 'whatsapp' as const;
    private sock: WASocket | null = null;
    private connected = false;
    private readonly primaryGroupJid = process.env.WHATSAPP_PRIMARY_GROUP_JID || '';
    private readonly processedMessageIds = new Map<string, number>();

    async connect(): Promise<void> {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            // Lightweight mode for RPi4
            browser: ['PiPi Bot', 'Chrome', '120.0'],
        });

        // Persist auth state on every update
        this.sock.ev.on('creds.update', saveCreds);

        // Connection status
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WHATSAPP] Scan QR code above to authenticate');
            }

            if (connection === 'open') {
                this.connected = true;
                console.log('[WHATSAPP] Connected');
            }

            if (connection === 'close') {
                this.connected = false;
                const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

                if (reason === DisconnectReason.loggedOut) {
                    console.warn('[WHATSAPP] Logged out — delete auth folder and re-scan QR');
                    return;
                }

                // Auto-reconnect for transient failures
                console.log(`[WHATSAPP] Disconnected (reason: ${reason}), reconnecting...`);
                setTimeout(() => this.connect(), 5_000);
            }
        });

        // Process live inbound text messages directly into the shared router.
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                const inbound = buildWhatsAppInboundMessage({
                    message: msg,
                    primaryGroupJid: this.primaryGroupJid || undefined,
                    botUserId: jidToPhone(this.sock?.user?.id || ''),
                });
                if (!inbound) continue;
                if (!rememberProcessedWhatsAppMessage(this.processedMessageIds, inbound.messageId)) {
                    continue;
                }

                const handledCommand = await executeChannelCommand({
                    channel: 'whatsapp',
                    channelRef: inbound.channelRef,
                    senderId: inbound.senderId,
                    senderDisplayName: inbound.senderDisplayName || inbound.senderId,
                    isDirect: inbound.isDirect,
                    rawText: inbound.text,
                    reply: async (responseText: string) => {
                        await this.sendMessage(inbound.channelRef, responseText);
                    },
                });
                if (handledCommand) {
                    continue;
                }

                void dispatchIncomingChannelMessage(inbound).catch((error: any) => {
                    console.warn(`[WHATSAPP] Failed to dispatch inbound message: ${error.message}`);
                });
            }
        });

        // Wait for connection (max 30s)
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                if (!this.connected) {
                    console.warn('[WHATSAPP] Connection timeout — will retry in background');
                }
                resolve(); // don't block bootstrap
            }, 30_000);

            this.sock!.ev.on('connection.update', (update) => {
                if (update.connection === 'open') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.sock) {
            this.sock.end(undefined);
            this.sock = null;
        }
        this.connected = false;
        this.processedMessageIds.clear();
    }

    isConnected(): boolean {
        return this.connected && this.sock !== null;
    }

    async sendMessage(to: string, text: string, _opts?: MessageOptions): Promise<SendResult> {
        const jid = resolveWhatsAppSendTarget(to);

        if (!this.isConnected()) {
            const cleanPhone = jidToPhone(jid);
            const waPhone = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;
            return {
                success: false,
                error: 'WhatsApp not connected',
                fallbackUrl: waPhone ? `https://wa.me/${waPhone}?text=${encodeURIComponent(text)}` : undefined,
            };
        }

        try {
            const sent = await this.sock!.sendMessage(jid, { text });
            return {
                success: true,
                messageId: sent?.key?.id || undefined,
            };
        } catch (err: any) {
            const cleanPhone = jidToPhone(jid);
            const waPhone = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;
            return {
                success: false,
                error: err.message,
                fallbackUrl: waPhone ? `https://wa.me/${waPhone}?text=${encodeURIComponent(text)}` : undefined,
            };
        }
    }
}

// ==========================================
// Self-registration
// ==========================================

if (process.env.WHATSAPP_ENABLED === 'true') {
    registerChannel('whatsapp', () => new WhatsAppChannel());
}
