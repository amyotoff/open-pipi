import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContentScaffold, createContentScaffold } from './content-scaffold';
import { validateGroundingRoot, validatePackRoot } from './content-validator';

const temporaryRoots: string[] = [];

function temporaryProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-scaffold-'));
    temporaryRoots.push(root);
    return root;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installable content scaffolder', () => {
    it('builds minimal pack and grounding templates', () => {
        const pack = buildContentScaffold('pack', 'my_assistant');
        const grounding = buildContentScaffold('grounding', 'my_world');

        expect(Object.keys(pack.files).sort()).toEqual(['agent.md', 'skills.md']);
        expect(pack.files['agent.md']).toContain('"id": "my_assistant"');
        expect(Object.keys(grounding.files).sort()).toEqual([
            'glossary.md',
            'grounding.md',
            'operating.md',
            'people.md',
        ]);
        expect(grounding.files['grounding.md']).toContain('"title": "My World"');
    });

    it('creates scaffolds that pass the strict content validator', () => {
        const projectRoot = temporaryProject();
        const pack = createContentScaffold({ projectRoot, kind: 'pack', id: 'my_assistant' });
        const grounding = createContentScaffold({ projectRoot, kind: 'grounding', id: 'my_world' });

        expect(validatePackRoot(pack.targetRoot, 'my_assistant').status).toBe('pass');
        expect(validateGroundingRoot(grounding.targetRoot, 'my_world').status).toBe('pass');
    });

    it('supports dry-run without writing files', () => {
        const projectRoot = temporaryProject();
        const result = createContentScaffold({ projectRoot, kind: 'pack', id: 'preview_pack', dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.files).toEqual(['agent.md', 'skills.md']);
        expect(fs.existsSync(result.targetRoot)).toBe(false);
    });

    it('refuses unsafe IDs and existing directories', () => {
        expect(() => buildContentScaffold('pack', '../private')).toThrow('Content ID must start');
        expect(() => buildContentScaffold('grounding', '')).toThrow('Content ID must start');

        const projectRoot = temporaryProject();
        const created = createContentScaffold({ projectRoot, kind: 'pack', id: 'existing' });
        const original = fs.readFileSync(path.join(created.targetRoot, 'agent.md'), 'utf-8');

        expect(() => createContentScaffold({ projectRoot, kind: 'pack', id: 'existing' })).toThrow(
            'Refusing to overwrite existing pack directory'
        );
        expect(fs.readFileSync(path.join(created.targetRoot, 'agent.md'), 'utf-8')).toBe(original);
    });
});
