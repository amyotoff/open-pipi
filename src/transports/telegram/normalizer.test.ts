import { describe, expect, it } from 'vitest';
import {
    isAddressedToTelegramBot,
    normalizeTelegramEndpointType,
    normalizeTelegramMessage,
    readTelegramText,
} from './normalizer';
import type { TelegramNormalizerInput } from './normalizer';

const BOT = { id: 900900, username: 'pipi_bot' };

/**
 * Each override replaces its part wholesale rather than merging into the
 * default. Merging would quietly re-add a `text` to a fixture meant to have
 * none, and the "nothing routable here" cases are exactly what needs testing.
 */
function buildInput(overrides: Partial<TelegramNormalizerInput> = {}): TelegramNormalizerInput {
    return {
        message: 'message' in overrides ? overrides.message! : { message_id: 42, date: 1_760_000_000, text: 'hello' },
        chat: 'chat' in overrides ? overrides.chat! : { id: -1001234, type: 'supergroup', title: 'Household' },
        from: 'from' in overrides ? overrides.from : { id: 777, username: 'alex', first_name: 'Alex' },
        bot: 'bot' in overrides ? overrides.bot : BOT,
    };
}

describe('telegram normalizer', () => {
    describe('endpoint types', () => {
        it('collapses Telegram chat types into the shared closed set', () => {
            expect(normalizeTelegramEndpointType('private')).toBe('direct');
            expect(normalizeTelegramEndpointType('group')).toBe('group');
            expect(normalizeTelegramEndpointType('supergroup')).toBe('group');
            expect(normalizeTelegramEndpointType('channel')).toBe('channel');
        });

        it('treats an unknown chat type as a group rather than a direct chat', () => {
            // Guessing "direct" would hand a stranger the private-chat code path.
            expect(normalizeTelegramEndpointType(undefined)).toBe('group');
            expect(normalizeTelegramEndpointType('something_new')).toBe('group');
        });
    });

    describe('text', () => {
        it('reads a caption when there is no text, matching the legacy router', () => {
            expect(readTelegramText({ text: 'body' })).toBe('body');
            expect(readTelegramText({ caption: 'photo caption' })).toBe('photo caption');
            expect(readTelegramText({})).toBe('');
        });
    });

    describe('normalizeTelegramMessage', () => {
        it('produces an id that matches the legacy stored message id', () => {
            const message = normalizeTelegramMessage(buildInput())!;

            // The router stored `${spaceId}:${messageId}` and a legacy space id
            // is `telegram:<chat>`, so replays of old messages stay deduplicated.
            expect(message.id).toBe('telegram:-1001234:42');
        });

        it('carries sender, endpoint, and timestamp across', () => {
            const message = normalizeTelegramMessage(buildInput())!;

            expect(message.transport).toBe('telegram');
            expect(message.endpoint).toEqual({ id: '-1001234', type: 'group', title: 'Household' });
            expect(message.sender).toEqual({
                transportUserId: '777',
                displayName: 'Alex',
                username: 'alex',
                isBot: false,
            });
            expect(message.content.text).toBe('hello');
            expect(message.timestamp).toBe(new Date(1_760_000_000 * 1000).toISOString());
            expect(message.correlationId).toMatch(/^[0-9a-f-]{36}$/);
        });

        it('falls back to the display name Telegram actually provides', () => {
            const withoutFirstName = normalizeTelegramMessage(buildInput({ from: { id: 777, username: 'alex' } }))!;
            const withNeither = normalizeTelegramMessage(buildInput({ from: { id: 777 } }))!;

            expect(withoutFirstName.sender.displayName).toBe('alex');
            expect(withNeither.sender.displayName).toBeNull();
        });

        it('keeps the largest photo and hides the file id from Core', () => {
            const message = normalizeTelegramMessage(
                buildInput({
                    message: {
                        message_id: 42,
                        date: 1_760_000_000,
                        caption: 'look',
                        photo: [
                            { file_id: 'small', file_unique_id: 'u1', file_size: 100 },
                            { file_id: 'large', file_unique_id: 'u2', file_size: 900 },
                        ],
                    },
                })
            )!;

            const attachment = message.content.attachments![0];
            expect(attachment.type).toBe('image');
            expect(attachment.id).toBe('u2');
            expect(attachment.sizeBytes).toBe(900);
            // The file id is transport trivia: the adapter trades it for a local
            // path, so it travels in metadata and never becomes a Core concept.
            expect(attachment.metadata).toEqual({ fileId: 'large' });
            expect(message.content.text).toBe('look');
        });

        it('normalizes a reply into transport-neutral context', () => {
            const message = normalizeTelegramMessage(
                buildInput({
                    message: {
                        message_id: 42,
                        date: 1_760_000_000,
                        text: 'agreed',
                        reply_to_message: {
                            message_id: 41,
                            text: 'the plan is ready',
                            from: { id: 900900, username: 'pipi_bot', is_bot: true },
                        },
                    },
                })
            )!;

            expect(message.replyTo).toEqual({
                transportMessageId: '41',
                sender: {
                    transportUserId: '900900',
                    displayName: 'pipi_bot',
                    username: 'pipi_bot',
                    isBot: true,
                },
                text: 'the plan is ready',
            });
        });

        it('carries a forum thread id', () => {
            const message = normalizeTelegramMessage(
                buildInput({ message: { message_id: 42, date: 1_760_000_000, text: 'hi', message_thread_id: 7 } })
            )!;

            expect(message.threadId).toBe('7');
        });

        it('drops updates with nothing routable in them', () => {
            // A sticker or a service notice — not an error, just not a message.
            expect(normalizeTelegramMessage(buildInput({ message: { message_id: 42, date: 1 } }))).toBeNull();
            expect(normalizeTelegramMessage(buildInput({ chat: { id: undefined } }))).toBeNull();
            expect(normalizeTelegramMessage(buildInput({ message: { text: 'hi' } }))).toBeNull();
            expect(normalizeTelegramMessage(buildInput({ from: { id: undefined } }))).toBeNull();
        });

        it('synthesizes a timestamp when the update carries none', () => {
            const before = Date.now();
            const message = normalizeTelegramMessage(buildInput({ message: { message_id: 42, text: 'hi' } }))!;

            expect(Date.parse(message.timestamp)).toBeGreaterThanOrEqual(before);
        });
    });

    describe('isAddressedToTelegramBot', () => {
        it('recognizes an @mention regardless of case', () => {
            expect(
                isAddressedToTelegramBot(buildInput({ message: { message_id: 1, text: 'hey @PiPi_Bot help' } }))
            ).toBe(true);
            expect(
                isAddressedToTelegramBot(buildInput({ message: { message_id: 1, text: 'hey @pipi_bot_backup' } }))
            ).toBe(false);
        });

        it('recognizes a reply to the assistant only by its exact username or id', () => {
            const replyingTo = (from: Record<string, unknown>) =>
                isAddressedToTelegramBot(
                    buildInput({
                        message: { message_id: 1, text: 'thanks', reply_to_message: { message_id: 0, from } },
                    })
                );

            expect(replyingTo({ id: 900900 })).toBe(true);
            expect(replyingTo({ id: 5, username: 'pipi_bot' })).toBe(true);
            expect(replyingTo({ id: 5, username: 'other_bot', is_bot: true })).toBe(false);
        });

        it('stays false for ordinary chatter and replies between people', () => {
            expect(isAddressedToTelegramBot(buildInput({ message: { message_id: 1, text: 'lunch?' } }))).toBe(false);
            expect(
                isAddressedToTelegramBot(
                    buildInput({
                        message: {
                            message_id: 1,
                            text: 'sure',
                            reply_to_message: { message_id: 0, from: { id: 888, username: 'sam' } },
                        },
                    })
                )
            ).toBe(false);
        });

        it('does not claim to be addressed when the bot identity is unknown', () => {
            expect(
                isAddressedToTelegramBot(buildInput({ bot: undefined, message: { message_id: 1, text: '@x' } }))
            ).toBe(false);
        });
    });
});
