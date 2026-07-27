/**
 * OutgoingMessage -> what Telegram will actually accept.
 *
 * Core produces one semantic answer; the transport decides its physical shape.
 * For Telegram that means the 4096-character ceiling, which nothing enforced
 * before: a longer reply failed, and the plain-text fallback failed the same
 * way, so the user simply got nothing.
 *
 * Splitting happens on the *source* text, and each piece is measured after
 * formatting. Measuring the source instead would be wrong — escaping expands
 * `&` into `&amp;`, so a chunk that fits before formatting can overflow after.
 */

import { formatTelegramText } from '../../channels/telegram-format';
import type { OutgoingMessage, RenderedDelivery, TransportCapabilities } from '../types';

/** Telegram counts the entity-parsed message, so the formatted form is what matters. */
function formattedLength(text: string): number {
    return formatTelegramText(text).html.length;
}

/**
 * Break one over-long line that has no newline to split on.
 *
 * Words first, so a sentence is not cut mid-token; a single word longer than
 * the whole limit is cut by characters, because there is nothing else to do
 * with it.
 */
function splitLongLine(line: string, limit: number): string[] {
    const pieces: string[] = [];
    let current = '';

    for (const word of line.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        if (formattedLength(candidate) <= limit) {
            current = candidate;
            continue;
        }

        // Whatever had accumulated is final; every path below starts a new piece.
        if (current) pieces.push(current);

        if (formattedLength(word) <= limit) {
            current = word;
            continue;
        }

        let remainder = word;
        while (remainder && formattedLength(remainder) > limit) {
            let take = remainder.length;
            while (take > 1 && formattedLength(remainder.slice(0, take)) > limit) {
                take -= 1;
            }
            pieces.push(remainder.slice(0, take));
            remainder = remainder.slice(take);
        }
        current = remainder;
    }

    if (current) pieces.push(current);
    return pieces;
}

/**
 * Split text into pieces that each survive formatting.
 *
 * Newlines are the preferred boundary, and not only for readability: the
 * Telegram formatter never opens a tag on one line and closes it on another,
 * so a newline split can never leave a piece with unbalanced markup.
 */
export function splitTelegramText(text: string, limit: number): string[] {
    if (!text) return [];
    if (formattedLength(text) <= limit) return [text];

    const chunks: string[] = [];
    let current = '';

    for (const line of text.split('\n')) {
        const candidate = current ? `${current}\n${line}` : line;
        if (formattedLength(candidate) <= limit) {
            current = candidate;
            continue;
        }

        // Whatever had accumulated is final; every path below starts a new chunk.
        if (current) chunks.push(current);

        if (formattedLength(line) <= limit) {
            current = line;
            continue;
        }

        const pieces = splitLongLine(line, limit);
        chunks.push(...pieces.slice(0, -1));
        current = pieces[pieces.length - 1] ?? '';
    }

    if (current) chunks.push(current);
    return chunks;
}

/**
 * Turn one outgoing message into the sequence of sends Telegram needs.
 *
 * Only the first piece carries the reply link and the pin: a pin on every
 * fragment of a long answer would be noise, and replying to the same message
 * repeatedly reads as a stutter.
 */
export function renderForTelegram(message: OutgoingMessage, capabilities: TransportCapabilities): RenderedDelivery[] {
    const limit = capabilities.maxTextLength ?? 4096;
    const deliveries: RenderedDelivery[] = [];

    for (const [index, chunk] of splitTelegramText(message.content.text || '', limit).entries()) {
        deliveries.push({
            text: chunk,
            ...(index === 0
                ? {
                      replyToTransportMessageId: message.replyTo?.transportMessageId,
                      pin: message.delivery?.pin,
                      unpinAfterHours: message.delivery?.unpinAfterHours,
                  }
                : {}),
            silent: message.delivery?.silent,
        });
    }

    for (const attachment of message.content.attachments ?? []) {
        deliveries.push({
            attachment,
            silent: message.delivery?.silent,
            pin: message.delivery?.pin,
            unpinAfterHours: message.delivery?.unpinAfterHours,
        });
    }

    return deliveries;
}
