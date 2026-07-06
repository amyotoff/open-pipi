import { describe, expect, it } from 'vitest';
import { computeInboxPollDelay } from './gmail';

describe('channels/gmail', () => {
    it('keeps the base polling cadence after successful polls', () => {
        expect(computeInboxPollDelay(60_000, 0)).toBe(60_000);
    });

    it('backs off exponentially after consecutive IMAP failures with a ceiling', () => {
        expect(computeInboxPollDelay(15_000, 1)).toBe(30_000);
        expect(computeInboxPollDelay(15_000, 2)).toBe(60_000);
        expect(computeInboxPollDelay(60_000, 4)).toBe(300_000);
    });
});
