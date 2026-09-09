import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGroundingPackFromRootStrict } from './grounding-loader';

describe('Jeeves starter grounding', () => {
    it('is valid, neutral, and contains no invented owner or office context', () => {
        const root = path.join(__dirname, '../groundings/jeeves_starter');
        const grounding = loadGroundingPackFromRootStrict(root);
        const content = [grounding.grounding_text, grounding.people_text, grounding.operating_text]
            .join('\n')
            .toLowerCase();

        expect(grounding).toMatchObject({
            id: 'jeeves_starter',
            title: 'Personal Assistant Starter',
            default_language: null,
            timezone: null,
        });
        expect(content).toContain('no people, relationships, roles, names, or identities are assumed');
        expect(content).toContain('do not invent personal facts');
        expect(content).not.toMatch(/office coordination|small-team|primary decision-maker/);
    });
});
