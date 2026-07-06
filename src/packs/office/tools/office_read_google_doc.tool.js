function extractGoogleDocId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const pathMatch = raw.match(/\/document\/(?:u\/\d+\/)?d\/([^/?#]+)/);
    if (pathMatch?.[1]) return pathMatch[1];

    try {
        const parsed = new URL(raw);
        return parsed.searchParams.get('id');
    } catch {
        return null;
    }
}

function buildPublicExportUrl(input, docId) {
    const exportUrl = new URL(`https://docs.google.com/document/d/${encodeURIComponent(docId)}/export`);
    exportUrl.searchParams.set('format', 'txt');

    try {
        const parsed = new URL(input);
        const resourceKey = parsed.searchParams.get('resourcekey');
        if (resourceKey) {
            exportUrl.searchParams.set('resourcekey', resourceKey);
        }
    } catch {}

    return exportUrl.toString();
}

function normalizeLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 12000;
    return Math.min(Math.max(Math.floor(parsed), 500), 50000);
}

async function fetchDocText(originalUrl, docId, accessToken) {
    // Prefer the Drive export API with Bearer auth when a token is available
    if (accessToken) {
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export?mimeType=text%2Fplain`;
        const response = await fetch(driveUrl, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/plain' },
        });
        if (response.ok) return { text: await response.text(), authed: true };
        if (response.status === 403 || response.status === 401) {
            return { text: null, authed: true, error: `Drive API returned ${response.status} — token may lack access to this document.` };
        }
        // Fall through to public export on other errors
    }

    // Pass original URL so resourcekey is preserved for shared links
    const publicUrl = buildPublicExportUrl(originalUrl, docId);
    const response = await fetch(publicUrl, { headers: { accept: 'text/plain' } });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            return { text: null, authed: false, error: 'Document is private. Use /gdrive auth to connect Google Drive.' };
        }
        return { text: null, authed: false, error: `Export returned HTTP ${response.status}.` };
    }

    const text = await response.text();
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!contentType.includes('text/plain') && /^<!doctype html|<html[\s>]/i.test(text)) {
        return { text: null, authed: false, error: 'Document is private. Share it publicly or use /gdrive auth.' };
    }

    return { text, authed: false };
}

module.exports = {
    packTool: {
        id: 'office_read_google_doc',
        title: 'Read Google Doc',
        description:
            'Read the plain text of a Google Doc. Uses OAuth if connected (/gdrive auth), otherwise falls back to public URL access.',
        parameters: {
            type: 'OBJECT',
            properties: {
                url: {
                    type: 'STRING',
                    description: 'A Google Docs document URL, usually containing /document/d/<id>.',
                },
                max_chars: {
                    type: 'NUMBER',
                    description: 'Optional maximum number of characters to return. Defaults to 12000.',
                },
            },
            required: ['url'],
        },
        execution: {
            run_mode: 'inline',
            capabilities: ['external_http'],
            approval: 'none',
            audit_default: 'errors',
        },
        async run(args, runtime) {
            const url = String(args?.url || '').trim();
            const docId = extractGoogleDocId(url);
            if (!docId) {
                return 'Google Docs reading needs a valid Google Docs URL containing /document/d/<id>.';
            }

            if (typeof fetch !== 'function') {
                return 'Google Docs reading is unavailable because this runtime does not provide fetch.';
            }

            const { text, error } = await fetchDocText(url, docId, runtime?.google_access_token || null);

            if (error) return `Google Docs reading failed: ${error}`;
            if (!text?.trim()) return 'Google Docs reading succeeded, but the exported document was empty.';

            const maxChars = normalizeLimit(args?.max_chars);
            const trimmed = text.trim();
            const clipped = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated]` : trimmed;

            return [
                'Google Docs reading result',
                `Document ID: ${docId}`,
                `Characters read: ${trimmed.length}`,
                '',
                clipped,
            ].join('\n');
        },
    },
};
