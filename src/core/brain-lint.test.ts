import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadLint(responses: string[] = []) {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-lint-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: 'test-key' };

    const generateBrainText = vi.fn();
    for (const response of responses) generateBrainText.mockResolvedValueOnce(response);
    generateBrainText.mockResolvedValue(JSON.stringify({ contradictions: [] }));

    vi.doMock('./brain-model', async () => {
        const actual = await vi.importActual<typeof import('./brain-model')>('./brain-model');
        return { ...actual, generateBrainText };
    });

    return {
        brain: await import('./brain'),
        lint: await import('./brain-lint'),
        ingest: await import('./brain-ingest'),
        store: await import('./brain-store'),
        generateBrainText,
    };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const store = await import('./brain-store');
        store.closeBrainDatabases();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('./brain-model');
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

const scope = { spaceId: 'telegram:chat-1' };
const codes = (report: { findings: Array<{ code: string }> }) => report.findings.map((finding) => finding.code);

describe('core/brain-lint', () => {
    it('drops index entries whose file is gone', async () => {
        const { brain, lint, store } = await loadLint();

        brain.updateWikiPage({ ...scope, path: 'health/sleep.md', body: '# Sleep\n\nA page.' });
        fs.rmSync(path.join(store.getBrainScopeRoot(scope), 'wiki', 'health', 'sleep.md'));

        const report = await lint.lintWiki({ ...scope, useModel: false });

        expect(codes(report)).toContain('index_stale_entry');
        expect(report.fixed).toBeGreaterThan(0);
        expect(brain.listWikiPages(scope).map((page) => page.path)).not.toContain('health/sleep.md');
    });

    it('repoints a broken link when exactly one file matches, and leaves knowledge dates alone', async () => {
        const { brain, lint } = await loadLint();

        brain.updateWikiPage({ ...scope, path: 'people/anna.md', body: '# Anna\n\nA person.' });
        brain.updateWikiPage({
            ...scope,
            path: 'projects/renovation.md',
            body: '# Renovation\n\nDiscussed with [Anna](../nonexistent/anna.md).',
        });

        const before = brain.listWikiPages(scope).find((page) => page.path === 'projects/renovation.md');
        const report = await lint.lintWiki({ ...scope, useModel: false });

        expect(codes(report)).toContain('link_repaired_body');
        const page = brain.readWikiPage('projects/renovation.md', scope);
        expect(page.content).toContain('](../people/anna.md)');

        const after = brain.listWikiPages(scope).find((page) => page.path === 'projects/renovation.md');
        // A link repair is bookkeeping, not new knowledge.
        expect(after?.knowledge_updated_at).toBe(before?.knowledge_updated_at);
    });

    it('removes a dead See Also link but reports a dead body link', async () => {
        const { brain, lint } = await loadLint();

        brain.updateWikiPage({
            ...scope,
            path: 'projects/renovation.md',
            body: [
                '# Renovation',
                '',
                'Refers to [Gone](../people/ghost.md).',
                '',
                '## See Also',
                '',
                '- [Also Gone](../people/phantom.md)',
            ].join('\n'),
        });

        const report = await lint.lintWiki({ ...scope, useModel: false });

        expect(codes(report)).toContain('see_also_removed');
        expect(codes(report)).toContain('link_dead');

        const page = brain.readWikiPage('projects/renovation.md', scope);
        expect(page.content).not.toContain('phantom.md');
        // The body link is a judgement call, so it survives for the owner to decide.
        expect(page.content).toContain('ghost.md');
    });

    it('reports claims that cannot be found in the linked raw source', async () => {
        const { brain, lint, ingest } = await loadLint();

        const captured = ingest.captureRawSource({
            ...scope,
            title: 'Sleep study',
            content: 'The study followed 1200 adults and reported a 14% drop in afternoon focus.',
            topic: 'health',
        });

        brain.updateWikiPage({
            ...scope,
            path: 'health/sleep.md',
            body: [
                '# Sleep',
                '',
                `The study followed 1200 adults and reported a 14% drop, published 2026-01-01.`,
                '',
                `Source: [study](../../${captured.source.path})`,
            ].join('\n'),
        });

        const report = await lint.lintWiki({ ...scope, useModel: false });
        const fidelity = report.findings.filter((finding) => finding.code.startsWith('source_fidelity_'));

        // 1200 and 14% are in the source; the date is not.
        expect(fidelity.map((finding) => finding.detail).join(' ')).toContain('2026-01-01');
        expect(fidelity.map((finding) => finding.detail).join(' ')).not.toContain('1200');
        expect(fidelity.every((finding) => finding.class === 'mechanical' && !finding.fixed)).toBe(true);
    });

    it('flags pages with no raw link, orphans, and pages left needing review', async () => {
        const { brain, lint } = await loadLint();

        brain.updateWikiPage({ ...scope, path: 'health/sleep.md', body: '# Sleep\n\nAn ungrounded claim.' });
        brain.updateWikiPage({
            ...scope,
            path: 'health/review.md',
            body: '---\n{"status":"needs_review"}\n---\n# Review\n\nFiled but not compiled.',
        });

        const report = await lint.lintWiki({ ...scope, useModel: false });

        expect(codes(report)).toContain('evidence_no_raw');
        expect(codes(report)).toContain('orphan_page');
        expect(codes(report)).toContain('needs_review');
    });

    it('reports captured sources that never became a page, ignoring no-material ones', async () => {
        const { lint, ingest, brain } = await loadLint();

        const orphaned = ingest.captureRawSource({ ...scope, title: 'A', content: 'Body A.', topic: 'health' });
        const thin = ingest.captureRawSource({ ...scope, title: 'B', content: 'Body B.', topic: 'health' });
        brain.appendWikiLog({
            ...scope,
            action: 'ingest',
            subject: `no material: ${thin.source.path}`,
            details: { Disposition: 'No material' },
        });
        ingest.reindexRawTree(scope);

        const report = await lint.lintWiki({ ...scope, useModel: false });
        const unreferenced = report.findings.filter((finding) => finding.code === 'raw_unreferenced');

        expect(unreferenced.map((finding) => finding.detail).join(' ')).toContain(orphaned.source.path);
        expect(unreferenced.map((finding) => finding.detail).join(' ')).not.toContain(thin.source.path);
    });

    it('reports malformed status blocks', async () => {
        const { brain, lint } = await loadLint();

        brain.updateWikiPage({
            ...scope,
            path: 'health/sleep.md',
            body: ['# Sleep', '', 'A claim.', '', '> **Status: Outdated**', '> ok', ''].join('\n'),
        });

        const report = await lint.lintWiki({ ...scope, useModel: false });
        expect(codes(report)).toContain('status_block_missing_date');
    });

    it('asks the model for contradictions only across pages sharing a source', async () => {
        const { brain, lint, ingest, generateBrainText } = await loadLint([
            JSON.stringify({
                contradictions: [{ pages: ['health/a.md', 'health/b.md'], detail: 'both state a different figure' }],
            }),
        ]);

        const captured = ingest.captureRawSource({ ...scope, title: 'S', content: 'Body.', topic: 'health' });
        for (const name of ['a', 'b']) {
            brain.updateWikiPage({
                ...scope,
                path: `health/${name}.md`,
                body: `# ${name}\n\nClaim.\n\n[src](../../${captured.source.path})`,
            });
        }

        const report = await lint.lintWiki({ ...scope });

        expect(generateBrainText).toHaveBeenCalled();
        const finding = report.findings.find((entry) => entry.code === 'contradiction');
        expect(finding?.class).toBe('judgment');
        expect(finding?.detail).toContain('both state a different figure');
    });

    it('logs the pass and paces itself on the sprint cadence', async () => {
        const { brain, lint } = await loadLint();

        expect(lint.isLintDue(scope, 7)).toBe(true);
        await lint.lintWiki({ ...scope, useModel: false, now: new Date('2026-08-13T04:00:00.000Z') });

        const entry = brain.readWikiLog(scope).find((row) => row.action === 'lint');
        expect(entry?.subject).toMatch(/^\d+ issues found, \d+ auto-fixed$/);

        expect(lint.isLintDue(scope, 7, new Date('2026-08-16T04:00:00.000Z'))).toBe(false);
        expect(lint.isLintDue(scope, 7, new Date('2026-08-20T04:00:00.000Z'))).toBe(true);
    });

    it('formats a digest that separates what was fixed from what needs a person', async () => {
        const { lint } = await loadLint();

        const digest = lint.formatLintDigest({
            issues: 3,
            fixed: 1,
            findings: [
                {
                    class: 'safe_fix',
                    code: 'link_repaired_body',
                    page: 'a.md',
                    detail: 'Repointed a link.',
                    fixed: true,
                },
                {
                    class: 'mechanical',
                    code: 'source_fidelity_decimal',
                    page: 'b.md',
                    detail: '"3.5" not found.',
                    fixed: false,
                },
                { class: 'judgment', code: 'orphan_page', page: 'c.md', detail: 'No inbound links.', fixed: false },
            ],
        });

        expect(digest).toContain('3 findings, 1 auto-fixed');
        expect(digest).toContain('Fixed:');
        expect(digest).toContain('Needs a decision:');
        expect(digest).toContain('Needs your judgement:');
    });

    it('removes only the dead link, not the sentence around it', async () => {
        const { brain, lint } = await loadLint();

        brain.updateWikiPage({ ...scope, path: 'people/anna.md', body: '# Anna\n\nA person.' });
        brain.updateWikiPage({
            ...scope,
            path: 'projects/renovation.md',
            body: [
                '# Renovation',
                '',
                '## See Also',
                '',
                '- Compare [Anna](../people/anna.md) with [Ghost](../people/ghost.md) — worth keeping',
                '- [Only Ghost](../people/ghost.md)',
            ].join('\n'),
        });

        await lint.lintWiki({ ...scope, useModel: false });
        const page = brain.readWikiPage('projects/renovation.md', scope);

        expect(page.content).not.toContain('ghost.md');
        // The valid link and the author's own words survive.
        expect(page.content).toContain('](../people/anna.md)');
        expect(page.content).toContain('worth keeping');
        // A bullet that held nothing but the dead link does go.
        expect(page.content).not.toContain('Only Ghost');
    });
});
