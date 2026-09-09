import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOwnerContext, saveOwnerContext } from '../setup/owner-context';
import { AgentOnboardingError, createAgentOnboardingService } from './service';

let dataDir: string;
let instant: Date;

beforeEach(() => {
    const testRoot = path.resolve(process.cwd(), '.tmp');
    fs.mkdirSync(testRoot, { recursive: true });
    dataDir = fs.mkdtempSync(path.join(testRoot, 'agent-onboarding-'));
    instant = new Date('2026-09-09T10:00:00.000Z');
});

afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function service() {
    return createAgentOnboardingService({ dataDir, now: () => instant });
}

function errorCode(action: () => unknown): string | undefined {
    try {
        action();
        return undefined;
    } catch (error) {
        return error instanceof AgentOnboardingError ? error.code : undefined;
    }
}

describe('agent onboarding service', () => {
    it('creates a bounded immutable preview without writing owner context and exposes it as latest state', () => {
        saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'UTC',
            displayName: 'Amy',
            facts: ['Existing fact'],
            currentTask: 'Existing task',
        });
        const before = readOwnerContext(dataDir);
        const preview = service().preview({ language: ' it ', timezone: 'Europe/Rome', facts: [' New fact '] });

        expect(readOwnerContext(dataDir)).toEqual(before);
        expect(preview).toMatchObject({
            baseRevision: before?.revision,
            ownerContext: {
                language: 'it',
                timezone: 'Europe/Rome',
                displayName: 'Amy',
                facts: ['New fact'],
                currentTask: 'Existing task',
            },
            effects: { ownerContextWrite: true, runtimeCalls: false, providerCalls: false },
            state: 'awaiting_confirmation',
        });
        expect(service().readState()).toMatchObject({ preview, state: 'awaiting_confirmation' });
        expect(fs.statSync(path.join(dataDir, 'agent-onboarding.json')).mode & 0o777).toBe(0o600);
    });

    it('strictly validates drafts and apply DTOs', () => {
        const onboarding = service();
        expect(errorCode(() => onboarding.preview({ language: 'en', timezone: 'UTC', surprise: true }))).toBe(
            'VALIDATION_FAILED'
        );
        expect(
            errorCode(() =>
                onboarding.preview({ language: 'en', timezone: 'UTC', facts: ['1', '2', '3', '4', '5', '6'] })
            )
        ).toBe('VALIDATION_FAILED');
        const preview = onboarding.preview({ language: 'en', timezone: 'UTC' });
        expect(
            errorCode(() =>
                onboarding.confirmAndApply({
                    previewId: preview.previewId,
                    previewHash: preview.previewHash,
                    idempotencyKey: 'request-1',
                    extra: true,
                } as never)
            )
        ).toBe('VALIDATION_FAILED');
    });

    it('applies the exact preview once and rejects key reuse for another preview', () => {
        const onboarding = service();
        const preview = onboarding.preview({
            language: 'it',
            timezone: 'Europe/Rome',
            facts: ['Prefers concise answers'],
            currentTask: 'Plan the week',
        });
        const input = {
            previewId: preview.previewId,
            previewHash: preview.previewHash,
            idempotencyKey: 'request-1',
        };
        const first = onboarding.confirmAndApply(input);
        const retry = onboarding.confirmAndApply(input);

        expect(retry).toEqual(first);
        expect(readOwnerContext(dataDir)).toEqual(first.ownerContext);
        const other = onboarding.preview({ language: 'en', timezone: 'UTC' });
        expect(
            errorCode(() =>
                onboarding.confirmAndApply({
                    previewId: other.previewId,
                    previewHash: other.previewHash,
                    idempotencyKey: 'request-1',
                })
            )
        ).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('applies explicit clearing of facts and current task exactly', () => {
        saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'UTC',
            facts: ['Remove me'],
            currentTask: 'Remove me too',
        });
        const onboarding = service();
        const preview = onboarding.preview({ language: 'en', timezone: 'UTC', facts: [], currentTask: '' });
        expect(preview.ownerContext).not.toHaveProperty('facts');
        expect(preview.ownerContext).not.toHaveProperty('currentTask');

        const result = onboarding.confirmAndApply({
            previewId: preview.previewId,
            previewHash: preview.previewHash,
            idempotencyKey: 'request-clear',
        });
        expect(result.ownerContext).not.toHaveProperty('facts');
        expect(result.ownerContext).not.toHaveProperty('currentTask');
    });

    it('rejects expiry, hash tampering and a changed base revision', () => {
        const onboarding = service();
        const expired = onboarding.preview({ language: 'en', timezone: 'UTC' });
        instant = new Date('2026-09-09T10:31:00.000Z');
        expect(
            errorCode(() =>
                onboarding.confirmAndApply({
                    previewId: expired.previewId,
                    previewHash: expired.previewHash,
                    idempotencyKey: 'request-expired',
                })
            )
        ).toBe('PREVIEW_EXPIRED');

        instant = new Date('2026-09-09T11:00:00.000Z');
        const conflict = onboarding.preview({ language: 'it', timezone: 'Europe/Rome' });
        saveOwnerContext(dataDir, { language: 'fr', timezone: 'Europe/Paris' });
        expect(
            errorCode(() =>
                onboarding.confirmAndApply({
                    previewId: conflict.previewId,
                    previewHash: conflict.previewHash,
                    idempotencyKey: 'request-conflict',
                })
            )
        ).toBe('VERSION_CONFLICT');
        expect(
            errorCode(() =>
                onboarding.confirmAndApply({
                    previewId: conflict.previewId,
                    previewHash: '0'.repeat(64),
                    idempotencyKey: 'request-tamper',
                })
            )
        ).toBe('PREVIEW_HASH_MISMATCH');
    });

    it('marks an applied preview as historical after a later owner context change', () => {
        const onboarding = service();
        const preview = onboarding.preview({ language: 'it', timezone: 'Europe/Rome' });
        onboarding.confirmAndApply({
            previewId: preview.previewId,
            previewHash: preview.previewHash,
            idempotencyKey: 'request-state',
        });
        expect(onboarding.readState(preview.previewId).currentMatchesPreview).toBe(true);
        saveOwnerContext(dataDir, { language: 'en', timezone: 'UTC' });
        expect(onboarding.readState(preview.previewId)).toMatchObject({
            state: 'applied',
            currentMatchesPreview: false,
        });
    });

    it('reconciles a crash after owner write only when a durable matching attempt exists', () => {
        const onboarding = service();
        const preview = onboarding.preview({ language: 'it', timezone: 'Europe/Rome', facts: ['Durable'] });
        const ledgerPath = path.join(dataDir, 'agent-onboarding.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
            attempts: Array<Record<string, string>>;
        };
        ledger.attempts.push({
            idempotencyKey: 'request-crash',
            previewId: preview.previewId,
            previewHash: preview.previewHash,
            startedAt: instant.toISOString(),
        });
        fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, { encoding: 'utf8', mode: 0o600 });
        saveOwnerContext(dataDir, preview.ownerContext);
        instant = new Date('2026-09-09T10:31:00.000Z');

        const recovered = onboarding.confirmAndApply({
            previewId: preview.previewId,
            previewHash: preview.previewHash,
            idempotencyKey: 'request-crash',
        });
        expect(recovered.ownerContext).toEqual(readOwnerContext(dataDir));
        expect(
            onboarding.confirmAndApply({
                previewId: preview.previewId,
                previewHash: preview.previewHash,
                idempotencyKey: 'request-crash',
            })
        ).toEqual(recovered);
    });

    it('fails closed when an existing owner context file is unreadable', () => {
        fs.writeFileSync(path.join(dataDir, 'setup-owner-context.json'), '{broken', { mode: 0o600 });
        expect(errorCode(() => service().preview({ language: 'en', timezone: 'UTC' }))).toBe('LEDGER_UNAVAILABLE');
        expect(fs.readFileSync(path.join(dataDir, 'setup-owner-context.json'), 'utf8')).toBe('{broken');
    });
});
