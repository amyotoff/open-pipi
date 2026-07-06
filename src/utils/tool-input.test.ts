import { describe, expect, it } from 'vitest';
import { normalizeArrayInput, normalizeEnumArray, normalizeNumberArray, normalizeStringArray } from './tool-input';

describe('tool input helpers', () => {
    it('normalizes unknown values into arrays', () => {
        expect(normalizeArrayInput(undefined)).toEqual([]);
        expect(normalizeArrayInput(null)).toEqual([]);
        expect(normalizeArrayInput('milk')).toEqual(['milk']);
        expect(normalizeArrayInput(['milk', 'bread'])).toEqual(['milk', 'bread']);
    });

    it('keeps only trimmed non-empty strings for string arrays', () => {
        expect(normalizeStringArray('  milk  ')).toEqual(['milk']);
        expect(normalizeStringArray(['milk', ' ', 123, ' bread '])).toEqual(['milk', 'bread']);
        expect(normalizeStringArray({ item: 'milk' })).toEqual([]);
    });

    it('keeps only finite numbers for number arrays', () => {
        expect(normalizeNumberArray(3)).toEqual([3]);
        expect(normalizeNumberArray([1, '2', Number.NaN, Infinity, 4])).toEqual([1, 4]);
        expect(normalizeNumberArray('3')).toEqual([]);
    });

    it('keeps only allowed enum values', () => {
        const allowed = ['low', 'medium', 'high'] as const;

        expect(normalizeEnumArray('low', allowed)).toEqual(['low']);
        expect(normalizeEnumArray(['low', 'urgent', 'high', 1], allowed)).toEqual(['low', 'high']);
        expect(normalizeEnumArray(undefined, allowed)).toEqual([]);
    });
});
