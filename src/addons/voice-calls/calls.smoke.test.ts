/**
 * The addon end to end, through the real skill handler and a real database,
 * with only the telephony faked.
 *
 * The unit tests cover the pieces. This covers the wiring between them — the
 * refusals, the daily ceiling, and that a task actually reaches the provider
 * with its guardrails attached.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

const CALL = {
    phone: '+391234567890',
    task_type: 'booking',
    goal: 'Book a table for two on 5 April at 20:00',
    contact_name: 'Trattoria da Bruno',
    service_context: 'Restaurant reservation',
    important_details: ['two people'],
    fallbacks: ['If 20:00 is gone, ask for 20:30.'],
};

/** Stands in for the telephony backend and records what it was asked to do. */
function fakeProvider(outcome?: Record<string, unknown>) {
    const placed: any[] = [];

    return {
        placed,
        provider: {
            name: 'fake',
            isConfigured: () => true,
            placeCall: async (toNumber: string, options: any) => {
                placed.push({ toNumber, options });
                return (
                    outcome ?? {
                        transcript: 'Agent: ... Host: ...',
                        duration_ms: 42_000,
                        status: 'user_hangup',
                        summary: 'Table confirmed.',
                        analysis: {
                            call_summary: 'Table confirmed.',
                            custom_analysis_data: {
                                call_status: 'completed',
                                goal_achieved: true,
                                outcome_summary: 'Table for two at 20:30.',
                                follow_up_needed: false,
                                confirmed_time: '2026-04-05 20:30',
                            },
                        },
                    }
                );
            },
        },
    };
}

async function loadSkill(withProvider?: ReturnType<typeof fakeProvider>) {
    vi.resetModules();

    const db = await import('../../db');
    db.initDatabase();
    db.upsertResident({ tg_id: '777', display_name: 'Marta', role: 'owner' });
    db.ensureSpace('telegram', '-100', { kind: 'group_chat', title: 'Household' });
    db.ensureSpaceMembership('telegram:-100', '777', 'owner');

    const addon = await import('./index');
    addon.resetVoiceProviders();
    if (withProvider) {
        addon.registerVoiceProvider('fake', () => withProvider.provider as any);
    }

    const skill = (await import('../../skills/phone.skill')).default;
    return { skill, db, addon };
}

function run(skill: any, args: Record<string, unknown>) {
    return skill.handlers.delegate_phone_call(args, { userId: '777', spaceId: 'telegram:-100' });
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-calls-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir };
});

afterEach(async () => {
    try {
        (await import('../../db')).closeDatabase();
    } catch {
        // The database may never have been opened.
    }
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('refusing before anything is dialled', () => {
    it('rejects a number that is not E.164 without touching a provider', async () => {
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        const result = await run(skill, { ...CALL, phone: '0612345678' });

        expect(result).toContain('not an E.164 number');
        expect(fake.placed).toHaveLength(0);
    });

    it('will not place a call when nobody said what failure looks like', async () => {
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        const result = await run(skill, { ...CALL, fallbacks: [] });

        expect(result).toContain('at least one fallback');
        expect(fake.placed).toHaveLength(0);
    });

    it('says calling is not set up rather than failing obscurely', async () => {
        const { skill } = await loadSkill();

        const result = await run(skill, CALL);

        expect(result).toContain('not configured');
    });
});

describe('the daily ceiling', () => {
    it('stops once the day is spent, and says how to change it', async () => {
        process.env.PIPI_DAILY_CALL_LIMIT = '2';
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        await run(skill, CALL);
        await run(skill, CALL);
        const third = await run(skill, CALL);

        expect(fake.placed).toHaveLength(2);
        expect(third).toContain('daily limit of 2 calls');
        expect(third).toContain('PIPI_DAILY_CALL_LIMIT');
    });

    it('counts a call that blew up, so a crash loop cannot dial forever', async () => {
        process.env.PIPI_DAILY_CALL_LIMIT = '1';
        const exploding = fakeProvider();
        exploding.provider.placeCall = async () => {
            throw new Error('carrier rejected the call');
        };
        const { skill } = await loadSkill(exploding);

        const first = await run(skill, CALL);
        const second = await run(skill, CALL);

        expect(first).toContain('could not be completed');
        // The failed attempt still spent the slot.
        expect(second).toContain('daily limit of 1 call');
    });

    it('switches calling off entirely at zero', async () => {
        process.env.PIPI_DAILY_CALL_LIMIT = '0';
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        expect(await run(skill, CALL)).toContain('switched off');
        expect(fake.placed).toHaveLength(0);
    });

    it('keeps the ceiling when the limit is nonsense', async () => {
        const fake = fakeProvider();

        for (const value of ['lots', '-3']) {
            process.env.PIPI_DAILY_CALL_LIMIT = value;
            const { addon } = await loadSkill(fake);
            // A typo must not remove the limit.
            expect(addon.dailyCallLimit(), value).toBe(10);
        }
    });
});

describe('the destination allowlist', () => {
    it('refuses a country the install does not call', async () => {
        process.env.PIPI_CALL_ALLOWED_COUNTRIES = '39,31';
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        const blocked = await run(skill, { ...CALL, phone: '+15551234567' });
        const allowed = await run(skill, { ...CALL, phone: '+390612345678' });

        expect(blocked).toContain('not allowed');
        expect(allowed).not.toContain('not allowed');
        expect(fake.placed).toHaveLength(1);
    });

    it('allows everywhere when no allowlist is set', async () => {
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        await run(skill, { ...CALL, phone: '+15551234567' });

        expect(fake.placed).toHaveLength(1);
    });
});

describe('a call that goes through', () => {
    it('hands the provider the task with its guardrails attached', async () => {
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        await run(skill, CALL);

        const [call] = fake.placed;
        expect(call.toNumber).toBe('+391234567890');
        expect(call.options.payload.goal).toBe(CALL.goal);
        // Defaults came from the booking template.
        expect(call.options.payload.must_collect).toContain('cancellation_policy');
        // Language was inferred from the +39 prefix rather than defaulting to English.
        expect(call.options.payload.expected_language).toBe('it');
        // The owner of this space, by name and nothing more.
        expect(call.options.identity.ownerName).toBe('Marta');
    });

    it('returns structure the next turn can branch on', async () => {
        const fake = fakeProvider();
        const { skill } = await loadSkill(fake);

        const result = await run(skill, CALL);
        const parsed = JSON.parse(result.slice(result.indexOf('{')));

        expect(parsed.status).toBe('completed');
        expect(parsed.goal_achieved).toBe(true);
        expect(parsed.agreements.confirmed_time).toBe('2026-04-05 20:30');
    });

    it('records the call without writing the full number into the log', async () => {
        const fake = fakeProvider();
        const { skill, db, addon } = await loadSkill(fake);

        await run(skill, CALL);

        const rows = db
            .getDb()
            .prepare('SELECT details FROM event_log WHERE event_type = ?')
            .all(addon.CALL_PLACED_EVENT) as Array<{ details: string }>;

        expect(rows).toHaveLength(1);
        expect(rows[0].details).not.toContain('+391234567890');
        expect(rows[0].details).toContain('telegram:-100');
    });
});
