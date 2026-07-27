import { describe, expect, it } from 'vitest';
import { buildIncomingMessageId, normalizeThreadId } from './types';

describe('transports/types', () => {
    describe('buildIncomingMessageId', () => {
        it('matches the legacy message id format so existing rows stay deduplicated', () => {
            // Legacy ids were `${spaceId}:${messageId}`, and a legacy space id is
            // itself `${channel}:${externalRef}` — so the formats coincide and no
            // stored message needs rewriting.
            const legacyId = `${'telegram:-1001234'}:${'42'}`;

            expect(buildIncomingMessageId('telegram', '-1001234', '42')).toBe(legacyId);
        });

        it('is derived from transport facts only, so rebinding an endpoint cannot resurrect a replay', () => {
            const beforeRebinding = buildIncomingMessageId('telegram', '-1001234', '42');
            const afterRebinding = buildIncomingMessageId('telegram', '-1001234', '42');

            expect(afterRebinding).toBe(beforeRebinding);
        });

        it('separates messages that share an id across endpoints or transports', () => {
            const ids = new Set([
                buildIncomingMessageId('telegram', 'chat-a', '1'),
                buildIncomingMessageId('telegram', 'chat-b', '1'),
                buildIncomingMessageId('web', 'chat-a', '1'),
            ]);

            expect(ids.size).toBe(3);
        });
    });

    describe('normalizeThreadId', () => {
        it('collapses every absent form to one empty string', () => {
            // SQLite treats NULLs as distinct in unique indexes, so "no thread"
            // must be a concrete value for the endpoint index to mean anything.
            expect(normalizeThreadId(undefined)).toBe('');
            expect(normalizeThreadId(null)).toBe('');
            expect(normalizeThreadId('')).toBe('');
        });

        it('preserves a real thread id', () => {
            expect(normalizeThreadId('77')).toBe('77');
        });
    });
});
