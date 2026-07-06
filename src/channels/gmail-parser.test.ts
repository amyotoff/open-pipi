import { describe, expect, it } from 'vitest';
import {
    extractEmailReplyText,
    normalizeEmailReplySubject,
    parseHeaderBlock,
    parseMailAddressHeader,
} from './gmail-parser';

describe('gmail-parser', () => {
    it('normalizes reply subjects without duplicating Re prefix', () => {
        expect(normalizeEmailReplySubject('Project update')).toBe('Re: Project update');
        expect(normalizeEmailReplySubject('Re: Project update')).toBe('Re: Project update');
    });

    it('parses unfolded headers and sender addresses', () => {
        const headers = parseHeaderBlock(
            'Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n' +
                'From: "Alice Example" <alice@example.com>\r\n' +
                'References: <one@example.com>\r\n <two@example.com>\r\n'
        );

        expect(headers.subject).toBe('Привет');
        expect(headers.references).toBe('<one@example.com> <two@example.com>');
        expect(parseMailAddressHeader(headers.from)).toEqual({
            address: 'alice@example.com',
            displayName: 'Alice Example',
        });
    });

    it('extracts visible plain-text reply content from multipart email bodies', () => {
        const raw = [
            'Content-Type: multipart/alternative; boundary="abc123"',
            '',
            '--abc123',
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            'Hello=2C yes tomorrow at 10=2E',
            '',
            'On Thu, 1 Jan 2026, Bob wrote:',
            '> old reply',
            '--abc123',
            'Content-Type: text/html; charset="UTF-8"',
            '',
            '<p>Hello, yes tomorrow at 10.</p>',
            '--abc123--',
        ].join('\r\n');

        expect(extractEmailReplyText(raw)).toBe('Hello, yes tomorrow at 10.');
    });

    it('falls back to html-only bodies when plain text is missing', () => {
        const raw = [
            'Content-Type: text/html; charset="UTF-8"',
            '',
            '<p>Status is <strong>green</strong>.</p><p>Thanks!</p>',
        ].join('\r\n');

        expect(extractEmailReplyText(raw)).toBe('Status is green .\nThanks!');
    });
});
