import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadAgency() {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-agency-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: 'test-key' };
    const generateBrainText = vi.fn();
    vi.doMock('./brain-model', async () => {
        const actual = await vi.importActual<typeof import('./brain-model')>('./brain-model');
        return { ...actual, generateBrainText };
    });
    return {
        brain: await import('./brain'),
        wiki: await import('./brain-wiki'),
        ingest: await import('./brain-ingest'),
        query: await import('./brain-query'),
        lint: await import('./brain-lint'),
        store: await import('./brain-store'),
        generateBrainText,
    };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        (await import('./brain-store')).closeBrainDatabases();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('./brain-model');
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

describe('advertising agency wiki regression', () => {
    it('keeps a shared campaign searchable, private, cited, and grounded through updates', async () => {
        const { brain, wiki, ingest, query, lint, store, generateBrainText } = await loadAgency();
        const operations = { spaceId: 'telegram:agency-ops' };
        const leadership = { spaceId: 'telegram:agency-leadership' };
        const shared = store.sharedScope(operations);

        const runCase = async (
            title: string,
            content: string,
            topic: string,
            triage: Record<string, unknown>,
            plan?: Record<string, unknown>
        ) => {
            generateBrainText.mockResolvedValueOnce(JSON.stringify(triage));
            if (plan) generateBrainText.mockResolvedValueOnce(JSON.stringify(plan));
            const captured = ingest.captureRawSource({ ...shared, title, content, topic });
            const run = await ingest.runIngestQueue({ ...shared, limit: 20 });
            expect(run.failed).toBe(0);
            return captured;
        };

        const rosterText =
            'Bob is account director; Alice is creative director; Bender is media buyer; Foxy is copywriter; Beaver is producer; Pinkie Pie is analytics lead.';
        const roster = await runCase(
            'Neon Beaver Creative roster',
            rosterText,
            'agency',
            { disposition: 'new', targets: [], rationale: 'new roster' },
            {
                subject: 'Agency roster',
                pages: [
                    {
                        path: 'agency/team.md',
                        title: 'Agency team',
                        body: '# Agency team\n\n[Bob](../people/bob.md), [Alice](../people/alice.md), [Bender](../people/bender.md), [Foxy](../people/foxy.md), [Beaver](../people/beaver.md), and [Pinkie Pie](../people/pinkie-pie.md).',
                    },
                    {
                        path: 'people/bob.md',
                        title: 'Bob',
                        body: '# Bob\n\nAccount director. [Team](../agency/team.md).',
                    },
                    {
                        path: 'people/alice.md',
                        title: 'Alice',
                        body: '# Alice\n\nCreative director. [Team](../agency/team.md).',
                    },
                    {
                        path: 'people/bender.md',
                        title: 'Bender',
                        body: '# Bender\n\nMedia buyer. [Team](../agency/team.md).',
                    },
                    { path: 'people/foxy.md', title: 'Foxy', body: '# Foxy\n\nCopywriter. [Team](../agency/team.md).' },
                    {
                        path: 'people/beaver.md',
                        title: 'Beaver',
                        body: '# Beaver\n\nProducer. [Team](../agency/team.md).',
                    },
                    {
                        path: 'people/pinkie-pie.md',
                        title: 'Pinkie Pie',
                        body: '# Pinkie Pie\n\nAnalytics lead. [Team](../agency/team.md).',
                    },
                ],
                cascade: [],
            }
        );

        const duplicate = ingest.captureRawSource({
            ...shared,
            title: 'Roster copy',
            content: rosterText,
            topic: 'misc',
        });
        expect(duplicate).toMatchObject({ duplicate: true });
        expect(duplicate.source.path).toBe(roster.source.path);

        const campaign = await runCase(
            'Orbit Coffee campaign brief',
            'Orbit Coffee launches 2026-09-15 with an approved €120,000 budget. Bender owns media. Pinkie Pie owns a 1.8% CTR floor and €18 CPA ceiling.',
            'campaigns',
            {
                disposition: 'new',
                targets: ['people/bender.md', 'people/pinkie-pie.md'],
                rationale: 'new campaign',
            },
            {
                subject: 'Orbit Coffee campaign',
                pages: [
                    {
                        path: 'campaigns/orbit-coffee.md',
                        title: 'Orbit Coffee campaign',
                        body: '# Orbit Coffee campaign\n\nLaunch: 2026-09-15. Approved budget: €120,000. CTR floor: 1.8%. CPA ceiling: €18.\n\n[Bender](../people/bender.md) owns media; [Pinkie Pie](../people/pinkie-pie.md) owns measurement.',
                    },
                ],
                cascade: [
                    {
                        path: 'people/bender.md',
                        heading: 'Campaigns',
                        body: 'Owns media for [Orbit Coffee](../campaigns/orbit-coffee.md), launching 2026-09-15.',
                    },
                    {
                        path: 'people/pinkie-pie.md',
                        heading: 'Campaigns',
                        body: 'Owns [Orbit Coffee measurement](../campaigns/orbit-coffee.md): CTR 1.8%, CPA €18.',
                    },
                ],
            }
        );

        const dispute = await runCase(
            'Orbit Coffee revised budget',
            'A client email says €100,000 replaces the earlier €120,000 approval; finance sign-off is pending.',
            'decisions',
            {
                disposition: 'disputed',
                targets: ['campaigns/orbit-coffee.md'],
                rationale: 'conflicting budget',
            },
            {
                subject: 'Orbit Coffee budget dispute',
                pages: [
                    {
                        path: 'decisions/orbit-coffee-budget.md',
                        title: 'Orbit Coffee budget dispute',
                        body: '# Orbit Coffee budget dispute\n\n> **Status: Disputed**\n> Earlier approval: €120,000. Client email: €100,000. Finance sign-off is pending.\n\n[Campaign](../campaigns/orbit-coffee.md)',
                    },
                ],
                cascade: [
                    {
                        path: 'campaigns/orbit-coffee.md',
                        heading: 'Budget status',
                        body: '> **Status: Disputed**\n> Earlier approval: €120,000. Client email: €100,000. Finance sign-off is pending.\n\n[Decision](../decisions/orbit-coffee-budget.md)',
                    },
                ],
            }
        );

        brain.updateWikiPage({
            ...operations,
            path: 'people/bob-compensation.md',
            body: '# Bob compensation\n\nPrivate operations discussion.',
        });

        const campaignPage = brain.readWikiPage('campaigns/orbit-coffee.md', shared);
        const campaignSources = wiki.parseJsonFrontmatter(campaignPage.content).meta.sources as string[];
        expect(campaignSources).toEqual(expect.arrayContaining([campaign.source.path, dispute.source.path]));

        const crossChat = query.searchWiki({ ...leadership, query: 'Orbit Coffee budget CTR CPA' });
        expect(crossChat[0].path).toBe('campaigns/orbit-coffee.md');
        expect(crossChat.map((hit) => hit.origin)).not.toContain('space');
        expect(query.searchWiki({ ...leadership, query: 'Bob compensation' }).map((hit) => hit.path)).not.toContain(
            'people/bob-compensation.md'
        );

        generateBrainText.mockResolvedValueOnce(
            'The budget is disputed between €120,000 and €100,000. See [campaign](campaigns/orbit-coffee.md) and [decision](decisions/orbit-coffee-budget.md).'
        );
        const answer = await query.answerFromWiki({ ...leadership, question: 'What is the Orbit Coffee budget?' });
        expect(answer.citations).toEqual(['campaigns/orbit-coffee.md', 'decisions/orbit-coffee-budget.md']);
        expect(query.buildWikiContextBlock({ ...leadership, query: 'Orbit Coffee budget CTR CPA' })).toContain(
            'untrusted index data'
        );

        const lintReport = await lint.lintWiki({ ...shared, useModel: false });
        const fidelity = lintReport.findings.filter((finding) => finding.code.startsWith('source_fidelity_'));
        expect(fidelity).toEqual([]);
        expect(brain.listWikiPages({ ...shared, limit: 100 })).toHaveLength(9);
    });
});
