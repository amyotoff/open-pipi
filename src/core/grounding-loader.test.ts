import { describe, expect, it } from 'vitest';

describe('core/grounding-loader', () => {
    it('loads the installable Jeeves grounding pack from its folder', async () => {
        const loader = await import('./grounding-loader');
        const pack = loader.loadInstallableGroundingPack('jeeves_personal');

        expect(pack).not.toBeNull();
        expect(pack?.id).toBe('jeeves_personal');
        expect(pack?.source).toBe('installable');
        expect(pack?.title).toBe('Скрепыш Office Coordination');
        expect(pack?.memory_focus).toEqual(expect.arrayContaining(['commitments', 'preferences']));
        expect(pack?.attention_bias).toEqual(
            expect.arrayContaining(['conflicting instructions', 'forgotten promises'])
        );
        expect(pack?.grounding_text).toContain('small-team office coordination space');
        expect(pack?.people_text).toContain('owner');
        expect(pack?.operating_text).toContain('Preserve promises');
        expect(pack?.glossary_text).toContain('memory sprint');
        expect(loader.getGroundingPackIds()).toContain('jeeves_personal');
    });

    it('returns a minimal shim when a grounding pack is missing', async () => {
        const loader = await import('./grounding-loader');
        const pack = loader.getGroundingPack('missing_grounding');

        expect(pack.id).toBe('missing_grounding');
        expect(pack.source).toBe('static');
        expect(pack.grounding_text).toContain('is not installed');
    });
});
