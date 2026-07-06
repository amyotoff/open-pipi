import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const readDocTool = require('../packs/office/tools/office_read_google_doc.tool.js').packTool;
const writeDocTool = require('../packs/office/tools/office_write_google_doc.tool.js').packTool;
const readSheetTool = require('../packs/office/tools/office_read_google_sheet.tool.js').packTool;
const writeSheetTool = require('../packs/office/tools/office_write_google_sheet.tool.js').packTool;

const RUNTIME_NO_TOKEN = { space_id: 'telegram:chat-1', google_access_token: undefined };
const RUNTIME_WITH_TOKEN = { space_id: 'telegram:chat-1', google_access_token: 'test-bearer-token' };

beforeEach(() => {
    vi.unstubAllGlobals();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ─── tool shape ──────────────────────────────────────────────────────────────

describe('office pack tool shapes', () => {
    it.each([
        ['office_read_google_doc', readDocTool],
        ['office_write_google_doc', writeDocTool],
        ['office_read_google_sheet', readSheetTool],
        ['office_write_google_sheet', writeSheetTool],
    ])('%s exports a valid packTool with id and run function', (_name, tool) => {
        expect(tool).toBeDefined();
        expect(typeof tool.id).toBe('string');
        expect(tool.id.length).toBeGreaterThan(0);
        expect(typeof tool.run).toBe('function');
        expect(tool.parameters).toBeDefined();
        expect(tool.execution).toBeDefined();
    });
});

// ─── office_read_google_doc ───────────────────────────────────────────────────

describe('office_read_google_doc', () => {
    it('rejects an invalid URL', async () => {
        const result = await readDocTool.run({ url: 'not-a-google-doc' }, RUNTIME_NO_TOKEN);
        expect(result).toMatch(/valid Google Docs URL/i);
    });

    it('reads a public doc when no token is present', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'text/plain' },
            text: async () => 'Hello from the doc',
        }));

        const result = await readDocTool.run(
            { url: 'https://docs.google.com/document/d/abc123/edit', max_chars: 5000 },
            RUNTIME_NO_TOKEN
        );
        expect(result).toContain('Google Docs reading result');
        expect(result).toContain('abc123');
        expect(result).toContain('Hello from the doc');
    });

    it('preserves resourcekey in the fallback public URL', async () => {
        const calls: [string, unknown][] = [];
        vi.stubGlobal('fetch', async (url: string, opts?: unknown) => {
            calls.push([url, opts]);
            return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'Content here' };
        });

        await readDocTool.run(
            { url: 'https://docs.google.com/document/d/abc123/edit?resourcekey=0-SecretKey' },
            RUNTIME_NO_TOKEN
        );

        expect(calls[0]?.[0]).toContain('resourcekey=0-SecretKey');
    });

    it('uses Drive API Bearer auth when token is available', async () => {
        const calls: [string, Record<string, unknown>][] = [];
        vi.stubGlobal('fetch', async (url: string, opts?: Record<string, unknown>) => {
            calls.push([url, opts ?? {}]);
            return { ok: true, status: 200, text: async () => 'Authenticated content' };
        });

        const result = await readDocTool.run(
            { url: 'https://docs.google.com/document/d/abc123/edit' },
            RUNTIME_WITH_TOKEN
        );

        expect(calls[0]?.[0]).toContain('googleapis.com/drive/v3/files');
        expect((calls[0]?.[1]?.headers as Record<string, string>)?.Authorization).toBe('Bearer test-bearer-token');
        expect(result).toContain('Authenticated content');
    });

    it('falls back to public export when Drive API returns a non-auth error', async () => {
        let callCount = 0;
        vi.stubGlobal('fetch', async (url: string) => {
            callCount++;
            if (url.includes('drive/v3/files')) {
                return { ok: false, status: 500, text: async () => 'server error' };
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => 'text/plain' },
                text: async () => 'Public fallback content',
            };
        });

        const result = await readDocTool.run(
            { url: 'https://docs.google.com/document/d/abc123/edit' },
            RUNTIME_WITH_TOKEN
        );
        expect(callCount).toBe(2);
        expect(result).toContain('Public fallback content');
    });

    it('returns an auth error when Drive API returns 403', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: false,
            status: 403,
            text: async () => 'forbidden',
        }));

        const result = await readDocTool.run(
            { url: 'https://docs.google.com/document/d/abc123/edit' },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toMatch(/403/);
    });
});

// ─── office_write_google_doc ──────────────────────────────────────────────────

describe('office_write_google_doc', () => {
    it('returns auth error when no token is present', async () => {
        const result = await writeDocTool.run({ text: 'Hello' }, RUNTIME_NO_TOKEN);
        expect(result).toMatch(/not connected/i);
    });

    it('returns error for empty text', async () => {
        const result = await writeDocTool.run({ text: '   ' }, RUNTIME_WITH_TOKEN);
        expect(result).toMatch(/empty/i);
    });

    it('appends text to an existing doc', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            json: async () => ({
                body: { content: [{ endIndex: 50 }] },
                replies: [],
            }),
        }));

        const result = await writeDocTool.run(
            { url: 'https://docs.google.com/document/d/doc-xyz/edit', text: 'Appended text.' },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toContain('doc-xyz');
        expect(result).toContain('Appended');
    });

    it('creates a new doc when no URL is provided', async () => {
        vi.stubGlobal('fetch', async (_url: string, _opts?: RequestInit) => {
            const isCreate = _url === 'https://docs.googleapis.com/v1/documents';
            return {
                ok: true,
                json: async () =>
                    isCreate
                        ? { documentId: 'new-doc-id', body: { content: [{ endIndex: 1 }] } }
                        : { body: { content: [{ endIndex: 1 }] }, replies: [] },
            };
        });

        const result = await writeDocTool.run({ title: 'My Doc', text: 'First line.' }, RUNTIME_WITH_TOKEN);
        expect(result).toContain('Created new Google Doc');
        expect(result).toContain('My Doc');
    });
});

// ─── office_read_google_sheet ─────────────────────────────────────────────────

describe('office_read_google_sheet', () => {
    it('returns auth error when no token is present', async () => {
        const result = await readSheetTool.run(
            { url: 'https://docs.google.com/spreadsheets/d/sheet-id/edit' },
            RUNTIME_NO_TOKEN
        );
        expect(result).toMatch(/not connected/i);
    });

    it('rejects an invalid URL', async () => {
        const result = await readSheetTool.run({ url: 'not-a-sheet' }, RUNTIME_WITH_TOKEN);
        expect(result).toMatch(/could not extract spreadsheet ID/i);
    });

    it('reads a sheet range and formats as tab-separated rows', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            json: async () => ({
                range: 'Sheet1!A1:B2',
                values: [
                    ['Name', 'Score'],
                    ['Alice', '95'],
                ],
            }),
        }));

        const result = await readSheetTool.run(
            { url: 'https://docs.google.com/spreadsheets/d/sheet-abc/edit', range: 'Sheet1!A1:B2' },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toContain('Google Sheets reading result');
        expect(result).toContain('sheet-abc');
        expect(result).toContain('Name\tScore');
        expect(result).toContain('Alice\t95');
    });

    it('returns friendly message for empty sheet', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            json: async () => ({ range: 'A1', values: [] }),
        }));

        const result = await readSheetTool.run(
            { url: 'https://docs.google.com/spreadsheets/d/sheet-empty/edit' },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toContain('(empty)');
    });
});

// ─── office_write_google_sheet ────────────────────────────────────────────────

describe('office_write_google_sheet', () => {
    it('returns auth error when no token is present', async () => {
        const result = await writeSheetTool.run(
            { url: 'https://docs.google.com/spreadsheets/d/s/edit', range: 'A1', values: [['x']] },
            RUNTIME_NO_TOKEN
        );
        expect(result).toMatch(/not connected/i);
    });

    it('returns error for invalid URL', async () => {
        const result = await writeSheetTool.run({ url: 'bad-url', range: 'A1', values: [['x']] }, RUNTIME_WITH_TOKEN);
        expect(result).toMatch(/could not extract/i);
    });

    it('returns error when neither values nor tsv is provided', async () => {
        const result = await writeSheetTool.run(
            { url: 'https://docs.google.com/spreadsheets/d/sheet-id/edit', range: 'A1' },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toMatch(/no data/i);
    });

    it('writes a 2D values array and reports updated cells', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            json: async () => ({ updatedRange: 'Sheet1!A1:B2', updatedCells: 4 }),
        }));

        const result = await writeSheetTool.run(
            {
                url: 'https://docs.google.com/spreadsheets/d/sheet-id/edit',
                range: 'A1',
                values: [
                    ['Name', 'Score'],
                    ['Bob', '88'],
                ],
            },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toContain('2 row(s)');
        expect(result).toContain('4 cell(s)');
    });

    it('parses tsv input when values is not provided', async () => {
        vi.stubGlobal('fetch', async () => ({
            ok: true,
            json: async () => ({ updatedRange: 'A1:B1', updatedCells: 2 }),
        }));

        const result = await writeSheetTool.run(
            {
                url: 'https://docs.google.com/spreadsheets/d/sheet-id/edit',
                range: 'A1',
                tsv: 'Col1\tCol2',
            },
            RUNTIME_WITH_TOKEN
        );
        expect(result).toContain('1 row(s)');
    });
});
