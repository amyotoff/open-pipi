/**
 * Gmail channel — outbound email via SMTP plus lightweight inbound polling via
 * IMAP. The inbound mode is intentionally simple: one correspondent email maps
 * to one space, while subject/message-id are used only as reply context.
 */

import tls from 'tls';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { OutboundChannel, SendResult, MessageOptions } from './_types';
import { registerChannel } from './_registry';
import { isGmailEnabled } from './_loader';
import { dispatchIncomingChannelMessage } from './runtime';
import { executeChannelCommand } from '../core/channel-commands';
import {
    extractEmailReplyText,
    normalizeEmailReplySubject,
    parseHeaderBlock,
    parseMailAddressHeader,
} from './gmail-parser';

const DEFAULT_IMAP_HOST = 'imap.gmail.com';
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_POLL_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 5 * 60_000;
const HEADER_FIELDS = 'FROM REPLY-TO SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES DATE';
const HEADER_SECTION = `BODY[HEADER.FIELDS (${HEADER_FIELDS})]`;

function getSmtpUser(): string {
    return process.env.CONCIERGE_SMTP_USER || '';
}

function getImapConfig(): { host: string; port: number; user: string; pass: string; pollMs: number } {
    return {
        host: process.env.GMAIL_IMAP_HOST || DEFAULT_IMAP_HOST,
        port: parseInt(process.env.GMAIL_IMAP_PORT || String(DEFAULT_IMAP_PORT), 10),
        user: process.env.GMAIL_IMAP_USER || getSmtpUser(),
        pass: process.env.GMAIL_IMAP_PASS || process.env.CONCIERGE_SMTP_PASS || '',
        pollMs: Math.max(parseInt(process.env.GMAIL_IMAP_POLL_MS || String(DEFAULT_POLL_MS), 10), 15_000),
    };
}

function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function imapQuote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function extractFetchLiteral(response: string, section: string): string {
    const pattern = new RegExp(
        `${escapeForRegExp(section)} \\{\\d+\\}\\r\\n([\\s\\S]*?)\\r\\n\\)\\r\\nA\\d+ (?:OK|NO|BAD)`,
        'i'
    );
    return response.match(pattern)?.[1] || '';
}

function parseUidList(response: string): string[] {
    const searchLine = response.match(/\* SEARCH(.*)\r\n/i)?.[1] || '';
    return searchLine.trim().split(/\s+/).filter(Boolean);
}

function extractReferenceIds(raw?: string | null, threadId?: string | null): string[] {
    const ids = (raw?.match(/<[^>]+>/g) || []).map((value) => value.trim());
    if (threadId && !ids.includes(threadId)) {
        ids.push(threadId);
    }
    return ids;
}

export function computeInboxPollDelay(basePollMs: number, consecutiveFailures: number): number {
    if (consecutiveFailures <= 0) {
        return basePollMs;
    }

    return Math.min(basePollMs * 2 ** consecutiveFailures, Math.max(basePollMs, MAX_POLL_BACKOFF_MS));
}

class SimpleImapSession {
    private socket: tls.TLSSocket;
    private buffer = '';
    private nextTag = 1;
    private waiters: Array<(error?: Error) => void> = [];

    private constructor(socket: tls.TLSSocket) {
        this.socket = socket;
        this.socket.setEncoding('utf8');
        this.socket.on('data', (chunk: Buffer | string) => {
            this.buffer += String(chunk);
            this.flushWaiters();
        });
        this.socket.on('error', (error) => {
            this.flushWaiters(error);
        });
        this.socket.on('end', () => {
            this.flushWaiters(new Error('IMAP connection ended.'));
        });
    }

    static async connect(host: string, port: number): Promise<SimpleImapSession> {
        const socket = tls.connect({
            host,
            port,
            servername: host,
        });

        await new Promise<void>((resolve, reject) => {
            socket.once('secureConnect', () => resolve());
            socket.once('error', reject);
        });

        const session = new SimpleImapSession(socket);
        await session.waitForPattern(/^\* (?:OK|PREAUTH)[^\r\n]*\r\n/i, 10_000);
        return session;
    }

    async login(user: string, pass: string): Promise<void> {
        // LOGIN is simple and interoperable here, but it relies on TLS for
        // transport security and expects an app password rather than OAuth2.
        await this.exec(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`);
    }

    async selectInbox(): Promise<void> {
        await this.exec('SELECT INBOX');
    }

    async searchUnreadUids(): Promise<string[]> {
        return parseUidList(await this.exec('UID SEARCH UNSEEN'));
    }

    async fetchHeaders(uid: string): Promise<string> {
        const response = await this.exec(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`);
        return extractFetchLiteral(response, HEADER_SECTION);
    }

    async fetchBody(uid: string): Promise<string> {
        const response = await this.exec(`UID FETCH ${uid} (BODY.PEEK[TEXT])`);
        return extractFetchLiteral(response, 'BODY[TEXT]');
    }

    async markSeen(uid: string): Promise<void> {
        await this.exec(`UID STORE ${uid} +FLAGS (\\Seen)`);
    }

    async logout(): Promise<void> {
        try {
            await this.exec('LOGOUT');
        } finally {
            this.close();
        }
    }

    close(): void {
        if (!this.socket.destroyed) {
            this.socket.end();
            this.socket.destroy();
        }
    }

    private flushWaiters(error?: Error): void {
        const pending = this.waiters.splice(0);
        for (const waiter of pending) {
            waiter(error);
        }
    }

    private async exec(command: string): Promise<string> {
        const tag = `A${this.nextTag++}`;
        this.socket.write(`${tag} ${command}\r\n`);
        const response = await this.waitForPattern(
            new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, 'i'),
            15_000
        );
        if (!new RegExp(`(?:^|\\r\\n)${tag} OK\\b`, 'i').test(response)) {
            throw new Error(`IMAP command failed: ${command}`);
        }
        return response;
    }

    private async waitForPattern(pattern: RegExp, timeoutMs: number): Promise<string> {
        const startedAt = Date.now();

        while (true) {
            const match = pattern.exec(this.buffer);
            if (match) {
                const end = match.index + match[0].length;
                const response = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end);
                return response;
            }

            const elapsed = Date.now() - startedAt;
            const remaining = timeoutMs - elapsed;
            if (remaining <= 0) {
                throw new Error('IMAP command timed out.');
            }

            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(new Error('IMAP command timed out.'));
                }, remaining);

                const waiter = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                };

                this.waiters.push(waiter);
            });
        }
    }
}

class GmailChannel implements OutboundChannel {
    readonly type = 'gmail' as const;
    private transporter: Transporter | null = null;
    private connected = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private polling = false;
    private inboxPollingEnabled = false;
    private consecutivePollFailures = 0;

    async connect(): Promise<void> {
        const host = process.env.CONCIERGE_SMTP_HOST;
        const user = getSmtpUser();
        const pass = process.env.CONCIERGE_SMTP_PASS;

        if (!host || !user || !pass) {
            throw new Error('SMTP not configured: set CONCIERGE_SMTP_HOST, _USER, _PASS');
        }

        this.transporter = nodemailer.createTransport({
            host,
            port: parseInt(process.env.CONCIERGE_SMTP_PORT || '587', 10),
            secure: false,
            auth: { user, pass },
        });

        try {
            await this.transporter.verify();
            this.connected = true;
        } catch (err: any) {
            console.warn(`[GMAIL] SMTP verify warning: ${err.message} — will try sending anyway`);
            this.connected = true;
        }

        this.startInboxPolling();
    }

    async disconnect(): Promise<void> {
        this.inboxPollingEnabled = false;
        this.clearPollTimer();

        if (this.transporter) {
            this.transporter.close();
            this.transporter = null;
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected && this.transporter !== null;
    }

    async sendMessage(to: string, text: string, opts?: MessageOptions): Promise<SendResult> {
        if (!this.isConnected() || !this.transporter) {
            return { success: false, error: 'SMTP not connected' };
        }

        const fromName = process.env.CONCIERGE_FROM_NAME || 'PiPi Bot';
        const fromAddr = getSmtpUser();
        const subject = opts?.threadId ? normalizeEmailReplySubject(opts?.subject) : opts?.subject || 'Service Request';

        try {
            const info = await this.transporter.sendMail({
                from: `"${fromName}" <${fromAddr}>`,
                to,
                subject,
                text,
                inReplyTo: opts?.threadId || undefined,
                references: opts?.references || (opts?.threadId ? [opts.threadId] : undefined),
            });

            return { success: true, messageId: info.messageId };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private startInboxPolling(): void {
        const imap = getImapConfig();
        if (!imap.user || !imap.pass) {
            console.log('[GMAIL] Inbound email-mode disabled: IMAP credentials not configured.');
            return;
        }

        this.inboxPollingEnabled = true;
        this.consecutivePollFailures = 0;
        this.scheduleNextPoll(0);
    }

    private async pollInbox(): Promise<void> {
        if (this.polling || !this.inboxPollingEnabled) return;

        const imap = getImapConfig();
        if (!imap.user || !imap.pass) return;

        this.polling = true;
        let session: SimpleImapSession | null = null;
        let nextDelayMs = imap.pollMs;

        try {
            session = await SimpleImapSession.connect(imap.host, imap.port);
            await session.login(imap.user, imap.pass);
            await session.selectInbox();
            this.consecutivePollFailures = 0;

            const unreadUids = await session.searchUnreadUids();
            if (unreadUids.length === 0) {
                await session.logout();
                session = null;
                return;
            }

            for (const uid of unreadUids) {
                try {
                    const headerBlock = await session.fetchHeaders(uid);
                    const bodyBlock = await session.fetchBody(uid);
                    const headers = parseHeaderBlock(headerBlock);
                    const sender = parseMailAddressHeader(headers['reply-to'] || headers.from);
                    const senderAddress = sender.address?.toLowerCase();

                    if (!senderAddress) {
                        continue;
                    }

                    if (senderAddress === getSmtpUser().toLowerCase()) {
                        await session.markSeen(uid);
                        continue;
                    }

                    const text = extractEmailReplyText(bodyBlock);
                    if (!text.trim()) {
                        await session.markSeen(uid);
                        continue;
                    }

                    const messageId = headers['message-id'] || `<gmail-${uid}@local>`;
                    const subject = headers.subject || 'PiPi Assistant';
                    const references = extractReferenceIds(headers.references, messageId);

                    const handledCommand = await executeChannelCommand({
                        channel: 'gmail',
                        channelRef: senderAddress,
                        senderId: senderAddress,
                        senderUsername: senderAddress,
                        senderDisplayName: sender.displayName || senderAddress,
                        isDirect: true,
                        rawText: text,
                        reply: async (responseText: string) => {
                            await this.sendMessage(senderAddress, responseText, {
                                subject,
                                threadId: messageId,
                                references,
                            });
                        },
                    });
                    if (handledCommand) {
                        await session.markSeen(uid);
                        continue;
                    }

                    await dispatchIncomingChannelMessage({
                        channel: 'gmail',
                        channelRef: senderAddress,
                        senderId: senderAddress,
                        senderUsername: senderAddress,
                        senderDisplayName: sender.displayName || senderAddress,
                        messageId,
                        text,
                        isDirect: true,
                        respond: async (responseText: string) => {
                            await this.sendMessage(senderAddress, responseText, {
                                subject,
                                threadId: messageId,
                                references,
                            });
                        },
                    });

                    await session.markSeen(uid);
                } catch (error: any) {
                    console.warn(`[GMAIL] Failed to process unread message ${uid}: ${error.message}`);
                }
            }

            await session.logout();
            session = null;
        } catch (error: any) {
            this.consecutivePollFailures += 1;
            nextDelayMs = computeInboxPollDelay(imap.pollMs, this.consecutivePollFailures);
            console.warn(
                `[GMAIL] Inbox poll failed: ${error.message}. Retrying in ${Math.round(nextDelayMs / 1000)}s.`
            );
        } finally {
            if (session) {
                session.close();
            }
            this.polling = false;
            if (this.inboxPollingEnabled) {
                this.scheduleNextPoll(nextDelayMs);
            }
        }
    }

    private clearPollTimer(): void {
        if (!this.pollTimer) {
            return;
        }

        clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    private scheduleNextPoll(delayMs: number): void {
        this.clearPollTimer();
        if (!this.inboxPollingEnabled) {
            return;
        }

        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.pollInbox();
        }, delayMs);
    }
}

// ==========================================
// Self-registration
// ==========================================

if (isGmailEnabled()) {
    registerChannel('gmail', () => new GmailChannel());
}
