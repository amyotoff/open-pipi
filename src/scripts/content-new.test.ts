import { describe, expect, it } from 'vitest';
import { parseContentNewArgs } from './content-new';

describe('content:new arguments', () => {
    it('parses pack and grounding requests with explicit flags', () => {
        expect(parseContentNewArgs(['--', 'pack', 'my_pack', '--dry-run'])).toEqual({
            kind: 'pack',
            id: 'my_pack',
            dryRun: true,
            json: false,
        });
        expect(parseContentNewArgs(['grounding', 'my_world', '--json'])).toEqual({
            kind: 'grounding',
            id: 'my_world',
            dryRun: false,
            json: true,
        });
    });

    it('rejects unknown flags and malformed positional arguments', () => {
        expect(() => parseContentNewArgs(['pack', 'my_pack', '--dru-run'])).toThrow('Usage:');
        expect(() => parseContentNewArgs(['unknown', 'my_pack'])).toThrow('Usage:');
        expect(() => parseContentNewArgs(['pack'])).toThrow('Usage:');
        expect(() => parseContentNewArgs(['pack', 'one', 'extra'])).toThrow('Usage:');
    });
});
