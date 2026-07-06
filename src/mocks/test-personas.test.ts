import { describe, it, expect } from 'vitest';

/**
 * Test personas sanity checks.
 * Ensures test fixtures are consistent and follow user rules.
 */

import { testPersonas, getMockPerson } from './test-personas';

describe('Test Personas', () => {
    it('should have standard personas: Alice, Bob, Bender', () => {
        expect(testPersonas.alice).toBeDefined();
        expect(testPersonas.bob).toBeDefined();
        expect(testPersonas.bender).toBeDefined();
    });

    it('should have correct IDs per user rules', () => {
        expect(testPersonas.alice.tg_id).toBe('111');
        expect(testPersonas.bob.tg_id).toBe('222');
        expect(testPersonas.bender.tg_id).toBe('333');
    });

    it('should have correct usernames', () => {
        expect(testPersonas.alice.username).toBe('alice');
        expect(testPersonas.bob.username).toBe('bob');
        expect(testPersonas.bender.username).toBe('bender');
    });

    it('should return correct persona via getMockPerson', () => {
        const alice = getMockPerson('alice');
        expect(alice.tg_id).toBe('111');
        expect(alice.display_name).toBe('Alice');
    });
});
