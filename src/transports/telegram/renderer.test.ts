import { describe, expect, it } from 'vitest';
import { formatTelegramText } from '../../channels/telegram-format';
import { renderForTelegram, splitTelegramText } from './renderer';
import { TELEGRAM_CAPABILITIES } from './capabilities';
import type { OutgoingMessage } from '../types';

function outgoing(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
    return {
        id: 'out-1',
        content: { text: 'hello' },
        ...overrides,
    };
}

describe('telegram renderer', () => {
    describe('splitTelegramText', () => {
        it('leaves a message that already fits alone', () => {
            expect(splitTelegramText('short', 4096)).toEqual(['short']);
            expect(splitTelegramText('', 4096)).toEqual([]);
        });

        it('splits an over-long reply instead of losing it', () => {
            // The bug this fixes: a reply past the limit failed to send, and the
            // plain-text fallback failed identically, so nothing arrived.
            const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
            const chunks = splitTelegramText(text, 500);

            expect(chunks.length).toBeGreaterThan(1);
            expect(chunks.join('\n')).toBe(text);
        });

        it('keeps every piece inside the limit once formatted, not before', () => {
            // Escaping expands the text, so measuring the source would let a
            // chunk sail past the ceiling after formatting.
            const text = Array.from({ length: 200 }, () => 'a & b < c > d').join('\n');
            const limit = 300;

            for (const chunk of splitTelegramText(text, limit)) {
                expect(formatTelegramText(chunk).html.length).toBeLessThanOrEqual(limit);
            }
        });

        it('never leaves a piece with unbalanced markup', () => {
            const text = Array.from({ length: 50 }, (_, i) => `**bold ${i}** and *italic ${i}*`).join('\n');

            for (const chunk of splitTelegramText(text, 200)) {
                const html = formatTelegramText(chunk).html;
                expect((html.match(/<b>/g) || []).length).toBe((html.match(/<\/b>/g) || []).length);
                expect((html.match(/<i>/g) || []).length).toBe((html.match(/<\/i>/g) || []).length);
            }
        });

        it('breaks a long unbroken line on word boundaries', () => {
            const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
            const chunks = splitTelegramText(text, 60);

            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                expect(formatTelegramText(chunk).html.length).toBeLessThanOrEqual(60);
                expect(chunk).not.toMatch(/^ | $/);
            }
            expect(chunks.join(' ')).toBe(text);
        });

        it('cuts a single word that is longer than the whole limit', () => {
            const chunks = splitTelegramText('x'.repeat(250), 100);

            expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
            expect(chunks.join('')).toBe('x'.repeat(250));
        });
    });

    describe('renderForTelegram', () => {
        it('renders a short message as a single delivery', () => {
            const deliveries = renderForTelegram(outgoing(), TELEGRAM_CAPABILITIES);

            expect(deliveries).toEqual([{ text: 'hello', replyToTransportMessageId: undefined, silent: undefined }]);
        });

        it('puts the reply link and the pin on the first piece only', () => {
            const message = outgoing({
                content: { text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') },
                replyTo: { transportMessageId: '77' },
                delivery: { pin: true, unpinAfterHours: 24 },
            });

            const deliveries = renderForTelegram(message, { ...TELEGRAM_CAPABILITIES, maxTextLength: 200 });

            expect(deliveries.length).toBeGreaterThan(1);
            expect(deliveries[0].replyToTransportMessageId).toBe('77');
            expect(deliveries[0].pin).toBe(true);
            // Pinning every fragment would be noise, and repeating the reply
            // link reads as a stutter.
            expect(deliveries.slice(1).every((delivery) => !delivery.pin)).toBe(true);
            expect(deliveries.slice(1).every((delivery) => !delivery.replyToTransportMessageId)).toBe(true);
        });

        it('sends attachments after the text', () => {
            const message = outgoing({
                content: {
                    text: 'see the brief',
                    attachments: [{ localPath: '/tmp/brief.html', filename: 'brief.html' }],
                },
            });

            const deliveries = renderForTelegram(message, TELEGRAM_CAPABILITIES);

            expect(deliveries).toHaveLength(2);
            expect(deliveries[0].text).toBe('see the brief');
            expect(deliveries[1].attachment?.localPath).toBe('/tmp/brief.html');
        });

        it('renders an attachment-only message', () => {
            const message = outgoing({
                content: { attachments: [{ localPath: '/tmp/a.png' }] },
            });

            const deliveries = renderForTelegram(message, TELEGRAM_CAPABILITIES);

            expect(deliveries).toHaveLength(1);
            expect(deliveries[0].attachment?.localPath).toBe('/tmp/a.png');
        });
    });
});
