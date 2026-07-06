import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadEvaluator() {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-evaluator-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    const db = await import('../db');
    db.initDatabase();
    const evaluator = await import('./evaluator');
    return { db, evaluator };
}

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/evaluator', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('runs the minimal operational evaluator and returns a clean pass report', async () => {
        const { evaluator } = await loadEvaluator();

        const report = await evaluator.runMinimalEvaluator();
        const compact = evaluator.toCompactOperationalReport(report);

        expect(report.ok).toBe(true);
        expect(report.total).toBe(8);
        expect(report.failed).toBe(0);
        expect(report.passed).toBe(8);
        expect(report.scenarios.map((scenario: any) => scenario.id)).toEqual([
            'space_bootstrap_and_pack_attach',
            'setup_facade_bootstrap',
            'memory_isolation',
            'tool_policy_block',
            'channel_mode_gate',
            'approval_single_pending',
            'cross_channel_continuation',
            'session_handoff',
        ]);
        expect(report.scenarios.every((scenario: any) => scenario.evidence.length > 0)).toBe(true);
        expect(compact.ok).toBe(true);
        expect(compact.failed_ids).toEqual([]);
        expect(compact.failures).toEqual([]);
        expect(compact.summary).toContain('No regressions detected');
        expect(compact.passed_ids).toEqual(report.scenarios.map((scenario: any) => scenario.id));
    });

    it('builds a compact operational report with severities and trimmed failures', async () => {
        const { evaluator } = await loadEvaluator();

        const compact = evaluator.toCompactOperationalReport({
            ok: false,
            started_at: '2026-03-30T10:00:00.000Z',
            finished_at: '2026-03-30T10:01:00.000Z',
            total: 5,
            passed: 3,
            failed: 2,
            skipped: 0,
            scenarios: [
                {
                    id: 'space_bootstrap_and_pack_attach',
                    title: 'Create space and attach pack',
                    status: 'passed',
                    summary: 'ok',
                    evidence: ['space_id=one'],
                },
                {
                    id: 'memory_isolation',
                    title: 'Memory stays isolated between spaces',
                    status: 'failed',
                    summary: 'Memory leaked across spaces.',
                    evidence: ['left=a', 'right=b', 'leak=yes', 'extra=ignored'],
                    error: 'cross-space leak',
                },
                {
                    id: 'tool_policy_block',
                    title: 'Tool policy blocks dangerous capability',
                    status: 'passed',
                    summary: 'ok',
                    evidence: ['blocked=true'],
                },
                {
                    id: 'cross_channel_continuation',
                    title: 'Continue the same space across channels',
                    status: 'passed',
                    summary: 'ok',
                    evidence: ['channels=2'],
                },
                {
                    id: 'session_handoff',
                    title: 'Session handoff preserves state',
                    status: 'failed',
                    summary: 'New session lost deployment state.',
                    evidence: ['memory=missing', 'history=missing'],
                    error: 'handoff dropped state',
                },
            ],
        });

        expect(compact.ok).toBe(false);
        expect(compact.generated_at).toBe('2026-03-30T10:01:00.000Z');
        expect(compact.failed_ids).toEqual(['memory_isolation', 'session_handoff']);
        expect(compact.passed_ids).toEqual([
            'space_bootstrap_and_pack_attach',
            'tool_policy_block',
            'cross_channel_continuation',
        ]);
        expect(compact.summary).toContain('memory_isolation, session_handoff');
        expect(compact.failures).toEqual([
            {
                id: 'memory_isolation',
                title: 'Memory stays isolated between spaces',
                severity: 'high',
                summary: 'Memory leaked across spaces.',
                evidence: ['left=a', 'right=b', 'leak=yes'],
                error: 'cross-space leak',
            },
            {
                id: 'session_handoff',
                title: 'Session handoff preserves state',
                severity: 'high',
                summary: 'New session lost deployment state.',
                evidence: ['memory=missing', 'history=missing'],
                error: 'handoff dropped state',
            },
        ]);
    });
});
