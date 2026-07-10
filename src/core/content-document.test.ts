import { describe, expect, it } from 'vitest';
import { parseJsonFrontmatter } from './content-document';

describe('JSON frontmatter documents', () => {
    it('parses LF and CRLF documents consistently', () => {
        expect(parseJsonFrontmatter<{ id: string }>('---\n{"id":"one"}\n---\nBody\n', 'one.md')).toEqual({
            meta: { id: 'one' },
            body: 'Body',
        });
        expect(parseJsonFrontmatter<{ id: string }>('---\r\n{"id":"two"}\r\n---\r\nBody\r\n', 'two.md')).toEqual({
            meta: { id: 'two' },
            body: 'Body',
        });
    });

    it('reports missing, invalid, and non-object frontmatter clearly', () => {
        expect(() => parseJsonFrontmatter('Body only', 'missing.md')).toThrow(
            'Expected JSON frontmatter in missing.md.'
        );
        expect(() => parseJsonFrontmatter('---\n{nope}\n---\nBody', 'invalid.md')).toThrow(
            'Invalid JSON frontmatter in invalid.md.'
        );
        expect(() => parseJsonFrontmatter('---\n[]\n---\nBody', 'array.md')).toThrow(
            'JSON frontmatter in array.md must be an object.'
        );
    });
});
