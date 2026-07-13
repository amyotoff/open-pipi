import { describe, expect, it } from 'vitest';
import { createWorkContract, parseWorkResult } from './work-contract';

describe('core/work-contract', () => {
    it('normalizes a compact delegation contract', () => {
        expect(
            createWorkContract({
                goal: '  Compare three options ',
                must_collect: [' price ', '', 'risks'],
            })
        ).toEqual(
            expect.objectContaining({
                goal: 'Compare three options',
                must_collect: ['price', 'risks'],
                forbidden_actions: [],
            })
        );
    });

    it('parses and clamps a structured result', () => {
        expect(
            parseWorkResult(
                '```json\n{"status":"completed","summary":"Done","facts":{"price":12},"blockers":[],"next_step":"Review","confidence":2}\n```'
            )
        ).toEqual({
            status: 'completed',
            summary: 'Done',
            facts: { price: 12 },
            blockers: [],
            next_step: 'Review',
            confidence: 1,
        });
    });

    it('keeps an unstructured response as a partial result', () => {
        expect(parseWorkResult('Useful notes, but not JSON')).toEqual(
            expect.objectContaining({ status: 'partial', summary: 'Useful notes, but not JSON', confidence: 0 })
        );
    });
});
