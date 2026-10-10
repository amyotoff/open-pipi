import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const A = '-1001111111111';
let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kismatik-answer-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, KISMATIK_CHAT_IDS: A, KISMATIK_EMBEDDER: 'none' };
    vi.resetModules();
});

afterEach(async () => {
    (await import('./store')).closeKismatikDb();
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('renderCitations', () => {
    it('links each source once, including ids listed inside one bracket', async () => {
        const { renderCitations } = await import('./answer');
        const { html, cited } = renderCitations(
            'Тбилиси [msg:305, msg:310] и удалённо [358]. Ещё раз [msg:305, 999].',
            A,
            new Set([305, 310, 358]),
            0
        );
        expect(html.match(/\/305"/g)).toHaveLength(1);
        expect(html).toContain('/310"');
        expect(html).not.toContain('msg:');
        expect(html).not.toContain('999');
        expect(cited).toBe(2);
    });

    it('turns markdown bold and bullets into Telegram HTML', async () => {
        const { renderCitations } = await import('./answer');
        const { html } = renderCitations('Города:\n*   **Милан** [msg:1]\n- Белград', A, new Set([1]), 0);
        expect(html).toContain('• <b>Милан</b>');
        expect(html).toContain('• Белград');
        expect(html).not.toContain('*');
    });
});
