import { describe, expect, it } from 'vitest';
import { buildAnalysisSchema, buildCallVariables, buildTaskPayload, inferLanguageFromPhone } from './prompt-builder';
import { TASK_TEMPLATES } from './templates';

const IDENTITY = { ownerName: 'Marta' };

const MINIMAL = {
    goal: 'Book a table for two on 5 April at 20:00',
    contact_name: 'Trattoria da Bruno',
    service_context: 'Restaurant reservation',
};

describe('inferring the call language', () => {
    it('reads the country code', () => {
        expect(inferLanguageFromPhone('+393331234567')).toBe('it');
        expect(inferLanguageFromPhone('+79161234567')).toBe('ru');
        expect(inferLanguageFromPhone('+31612345678')).toBe('nl');
    });

    it('prefers the longer prefix', () => {
        // +351 is Portugal; matching +3 first would make it Italian.
        expect(inferLanguageFromPhone('+351912345678')).toBe('pt');
        expect(inferLanguageFromPhone('+995599123456')).toBe('ka');
    });

    it('says nothing rather than guessing', () => {
        expect(inferLanguageFromPhone('+2681234567')).toBeUndefined();
    });
});

describe('building the task', () => {
    it('fills the gaps from the task type', () => {
        const payload = buildTaskPayload('booking', MINIMAL);

        expect(payload.must_collect).toEqual(TASK_TEMPLATES.booking.must_collect);
        expect(payload.forbidden_actions).toEqual(TASK_TEMPLATES.booking.forbidden_actions);
        expect(payload.call_mode).toBe('THIRD_PARTY_TASK_CALL');
    });

    it('lets the caller be more specific than the template', () => {
        const payload = buildTaskPayload('booking', {
            ...MINIMAL,
            must_collect: ['exact_time'],
            decision_rights: ['may accept any slot between 19:30 and 21:00'],
        });

        expect(payload.must_collect).toEqual(['exact_time']);
        expect(payload.decision_rights).toEqual(['may accept any slot between 19:30 and 21:00']);
    });
});

describe('the guardrails on every call', () => {
    it('forbids giving out the owner’s contact details', () => {
        const vars = buildCallVariables(buildTaskPayload('booking', MINIMAL), IDENTITY);

        expect(vars.forbidden_actions).toContain('Marta');
        expect(vars.forbidden_actions).toMatch(/do not share the direct phone number/i);
        expect(vars.fallback).toMatch(/cannot give out contact details/i);
    });

    it('cannot be displaced by a caller supplying their own restrictions', () => {
        const payload = buildTaskPayload('booking', { ...MINIMAL, forbidden_actions: ['do not mention the weather'] });
        const vars = buildCallVariables(payload, IDENTITY);

        // The caller's restriction is kept and the built-in one still lands.
        expect(vars.forbidden_actions).toContain('do not mention the weather');
        expect(vars.forbidden_actions).toMatch(/do not share the direct phone number/i);
    });

    it('still names someone when the space has no named owner', () => {
        const vars = buildCallVariables(buildTaskPayload('booking', MINIMAL), { ownerName: '   ' });

        expect(vars.forbidden_actions).toContain('the person you represent');
    });
});

describe('flattening for the prompt', () => {
    it('turns lists into bullets and the contract into JSON', () => {
        const payload = buildTaskPayload('booking', {
            ...MINIMAL,
            important_details: ['two people', 'window table if possible'],
        });
        const vars = buildCallVariables(payload, IDENTITY);

        expect(vars.important_details).toBe('- two people\n- window table if possible');
        expect(() => JSON.parse(vars.result_contract)).not.toThrow();
        // Every value has to be a string; a provider template cannot hold an array.
        expect(Object.values(vars).every((value) => typeof value === 'string')).toBe(true);
    });

    it('says so when a list is empty rather than leaving a blank', () => {
        const vars = buildCallVariables(buildTaskPayload('booking', MINIMAL), IDENTITY);

        expect(vars.important_details).toBe('(none provided)');
        expect(vars.hard_blockers).toBe('(none provided)');
    });

    it('demands one language when the language is known', () => {
        const known = buildCallVariables(
            buildTaskPayload('booking', { ...MINIMAL, expected_language: 'it' }),
            IDENTITY
        );
        const unknown = buildCallVariables(buildTaskPayload('booking', MINIMAL), IDENTITY);

        expect(known.language_directive).toContain('Italian');
        expect(known.expected_language).toBe('it');
        // An agent that reads its English instructions and concludes it should
        // speak English will open the call in the wrong language.
        expect(known.language_directive).toMatch(/do not speak English unless asked/i);

        expect(unknown.expected_language).toBe('multi');
        expect(unknown.language_directive).toMatch(/auto-detect/i);
    });
});

describe('the extraction schema', () => {
    it('always asks the questions every caller branches on', () => {
        for (const taskType of ['booking', 'appointment', 'info_verification', 'follow_up', 'owner_relay'] as const) {
            const names = buildAnalysisSchema(taskType).map((item) => item.name);
            expect(names, taskType).toEqual(
                expect.arrayContaining(['call_status', 'goal_achieved', 'outcome_summary', 'follow_up_needed'])
            );
        }
    });

    it('adds the fields that only make sense for this task', () => {
        expect(buildAnalysisSchema('booking').map((item) => item.name)).toContain('cancellation_policy');
        expect(buildAnalysisSchema('owner_relay').map((item) => item.name)).toContain('message_acknowledged');
        expect(buildAnalysisSchema('owner_relay').map((item) => item.name)).not.toContain('cancellation_policy');
    });

    it('constrains the status to the values the extractor understands', () => {
        const status = buildAnalysisSchema('booking').find((item) => item.name === 'call_status');

        expect(status?.type).toBe('enum');
        expect(status?.choices).toEqual(['completed', 'partial', 'blocked', 'no_answer', 'failed']);
    });
});
