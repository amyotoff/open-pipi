import { describe, expect, it } from 'vitest';
import { extractCallResult } from './result-extractor';

describe('when the provider extracted fields', () => {
    it('separates what was agreed from what was merely learned', () => {
        const result = extractCallResult(
            'Agent: ... Caller: ...',
            {
                call_summary: 'Table booked.',
                custom_analysis_data: {
                    call_status: 'completed',
                    goal_achieved: true,
                    outcome_summary: 'Table for two confirmed for 20:30.',
                    follow_up_needed: false,
                    confirmed_time: '2026-04-05 20:30',
                    reservation_name: 'Marta',
                    cancellation_policy: 'Free until 24h before.',
                },
            },
            'booking'
        );

        expect(result.status).toBe('completed');
        expect(result.goal_achieved).toBe(true);
        // An agreement is something the other party committed to; the policy is
        // a fact they stated.
        expect(result.agreements).toEqual({ confirmed_time: '2026-04-05 20:30', reservation_name: 'Marta' });
        expect(result.facts_collected.cancellation_policy).toBe('Free until 24h before.');
        expect(result.blockers).toEqual([]);
    });

    it('reads booleans whether they arrive as booleans or as strings', () => {
        const asStrings = extractCallResult(
            't',
            {
                custom_analysis_data: {
                    call_status: 'completed',
                    goal_achieved: 'true',
                    follow_up_needed: 'true',
                    outcome_summary: 'Done.',
                },
            },
            'booking'
        );

        expect(asStrings.goal_achieved).toBe(true);
        expect(asStrings.follow_up_needed).toBe(true);
    });

    it('translates each task’s own vocabulary into one status', () => {
        const cases: Array<[string, string, string]> = [
            ['booked', 'booking', 'completed'],
            ['scheduled', 'appointment', 'completed'],
            ['delivered', 'owner_relay', 'completed'],
            ['unavailable', 'booking', 'blocked'],
            ['partially_verified', 'info_verification', 'partial'],
            ['not_reached', 'owner_relay', 'no_answer'],
        ];

        for (const [raw, taskType, expected] of cases) {
            const result = extractCallResult(
                't',
                { custom_analysis_data: { call_status: raw, goal_achieved: false, outcome_summary: 's' } },
                taskType as never
            );
            expect(result.status, raw).toBe(expected);
        }
    });

    it('treats "None" as no next step, not as an instruction', () => {
        for (const value of ['None', 'null', 'N/A', 'nothing', '  ']) {
            const result = extractCallResult(
                't',
                { custom_analysis_data: { call_status: 'completed', goal_achieved: true, next_step: value } },
                'booking'
            );
            // Otherwise a person is told their next step is "None".
            expect(result.next_step, value).toBeNull();
        }
    });
});

describe('when only a summary came back', () => {
    it('reports lower confidence rather than inventing structure', () => {
        const result = extractCallResult(
            'Agent: ...',
            { call_summary: 'They will call back.', call_successful: false },
            'follow_up'
        );

        expect(result.facts_collected).toEqual({});
        expect(result.agreements).toEqual({});
        expect(result.confidence).toBeLessThan(0.5);
        expect(result.follow_up_needed).toBe(true);
    });

    it('calls voicemail a missed call', () => {
        const result = extractCallResult('beep', { call_summary: 'Voicemail.', in_voicemail: true }, 'booking');

        expect(result.status).toBe('no_answer');
    });
});

describe('when the call never really happened', () => {
    it('distinguishes nobody answering from a broken call', () => {
        expect(extractCallResult('', undefined, 'booking', 'dial_no_answer').status).toBe('no_answer');
        expect(extractCallResult('', undefined, 'booking', 'dial_busy').status).toBe('no_answer');
        expect(extractCallResult('', undefined, 'booking', 'error_unknown').status).toBe('failed');
    });

    it('does not call a completed conversation a failure just because nothing was extracted', () => {
        // The call connected and someone hung up normally. Reporting this as
        // failed would send someone to redial a call that already happened.
        const result = extractCallResult('', undefined, 'booking', 'user_hangup');

        expect(result.status).toBe('partial');
        expect(result.follow_up_needed).toBe(true);
    });

    it('always leaves a next step when it could not do the job', () => {
        const result = extractCallResult('', undefined, 'booking', 'dial_no_answer');

        expect(result.next_step).toBeTruthy();
        expect(result.confidence).toBeLessThan(0.3);
    });
});
