type ParsedMimePart = {
    contentType: string;
    transferEncoding: string;
    body: string;
};

function decodeQuotedPrintableToUtf8(input: string): string {
    const normalized = input.replace(/=\r?\n/g, '');
    const bytes: number[] = [];

    for (let index = 0; index < normalized.length; index++) {
        const char = normalized[index];
        const hex = normalized.slice(index + 1, index + 3);
        if (char === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
            bytes.push(parseInt(hex, 16));
            index += 2;
            continue;
        }

        bytes.push(normalized.charCodeAt(index));
    }

    return Buffer.from(bytes).toString('utf8');
}

function decodeEncodedWord(_match: string, encoding: string, payload: string): string {
    if (encoding.toLowerCase() === 'b') {
        return Buffer.from(payload, 'base64').toString('utf8');
    }

    const qp = payload.replace(/_/g, ' ');
    return decodeQuotedPrintableToUtf8(qp);
}

export function decodeMimeHeader(value: string): string {
    return value
        .replace(/=\?utf-8\?([bq])\?([^?]+)\?=/gi, (match, encoding, payload) =>
            decodeEncodedWord(match, encoding, payload)
        )
        .trim();
}

export function parseHeaderBlock(raw: string): Record<string, string> {
    const unfolded = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');

    const headers: Record<string, string> = {};
    for (const line of unfolded.split('\n')) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;

        const key = line.slice(0, separator).trim().toLowerCase();
        const value = decodeMimeHeader(line.slice(separator + 1).trim());
        if (!key) continue;
        headers[key] = value;
    }

    return headers;
}

export function parseMailAddressHeader(raw?: string | null): { address: string | null; displayName: string | null } {
    const value = decodeMimeHeader(String(raw || '').trim());
    if (!value) {
        return { address: null, displayName: null };
    }

    const bracketMatch = value.match(/^(.*)<([^>]+)>$/);
    if (bracketMatch) {
        const displayName = bracketMatch[1].trim().replace(/^"|"$/g, '') || null;
        return {
            address: bracketMatch[2].trim().toLowerCase(),
            displayName,
        };
    }

    const bareAddress = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
    if (bareAddress) {
        return { address: bareAddress.toLowerCase(), displayName: null };
    }

    return { address: null, displayName: value || null };
}

export function normalizeEmailReplySubject(subject?: string | null): string {
    const trimmed = decodeMimeHeader(String(subject || '').trim());
    if (!trimmed) return 'Re: PiPi Assistant';
    if (/^(re|aw|sv):/i.test(trimmed)) return trimmed;
    return `Re: ${trimmed}`;
}

function splitPartHeaders(raw: string): { headers: Record<string, string>; body: string } {
    const separator = raw.search(/\r?\n\r?\n/);
    if (separator === -1) {
        return { headers: {}, body: raw };
    }

    const headerBlock = raw.slice(0, separator);
    const body = raw.slice(separator).replace(/^\r?\n\r?\n/, '');
    return { headers: parseHeaderBlock(headerBlock), body };
}

function decodePartBody(part: ParsedMimePart): string {
    if (part.transferEncoding === 'base64') {
        try {
            return Buffer.from(part.body.replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch {
            return part.body;
        }
    }

    if (part.transferEncoding === 'quoted-printable') {
        return decodeQuotedPrintableToUtf8(part.body);
    }

    return part.body;
}

function htmlToText(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function findPreferredMimePart(raw: string): ParsedMimePart {
    const { headers, body } = splitPartHeaders(raw);
    const topContentType = String(headers['content-type'] || '').toLowerCase();
    const boundary = topContentType.match(/boundary="?([^";]+)"?/i)?.[1];

    if (!boundary) {
        return {
            contentType: topContentType || 'text/plain',
            transferEncoding: String(headers['content-transfer-encoding'] || '').toLowerCase(),
            body,
        };
    }

    const parts = body
        .split(`--${boundary}`)
        .map((part) => part.trim())
        .filter((part) => part && part !== '--');

    const parsedParts = parts.map((part) => {
        const { headers: partHeaders, body: partBody } = splitPartHeaders(part);
        return {
            contentType: String(partHeaders['content-type'] || '').toLowerCase(),
            transferEncoding: String(partHeaders['content-transfer-encoding'] || '').toLowerCase(),
            body: partBody,
        };
    });

    return (
        parsedParts.find((part) => part.contentType.includes('text/plain')) ||
        parsedParts.find((part) => part.contentType.includes('text/html')) || {
            contentType: 'text/plain',
            transferEncoding: '',
            body,
        }
    );
}

function stripQuotedHistory(text: string): string {
    const normalized = text.replace(/\r\n/g, '\n');
    const replyCutPatterns = [
        /\nOn .+wrote:\n/i,
        /\n-{2,}\s*Original Message\s*-{2,}\n/i,
        /\nFrom:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+\n/i,
        /\n_{6,}\n/,
    ];

    let visible = normalized;
    for (const pattern of replyCutPatterns) {
        const match = pattern.exec(visible);
        if (match) {
            visible = visible.slice(0, match.index);
            break;
        }
    }

    const lines = visible
        .split('\n')
        .filter((line) => !line.trim().startsWith('>'))
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean);

    return lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function extractEmailReplyText(raw: string): string {
    const preferred = findPreferredMimePart(raw);
    const decodedBody = decodePartBody(preferred);
    const text = preferred.contentType.includes('text/html') ? htmlToText(decodedBody) : decodedBody;

    return stripQuotedHistory(text);
}
