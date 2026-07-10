import { describe, expect, it, vi } from 'vitest';
import { Type } from '@google/genai';
import type { CapabilityMeta, SkillManifest } from './_types';
import { buildSkillToolRegistry } from './tool-registry';

const defaults: CapabilityMeta = {
    run_mode: 'inline',
    approval: 'none',
    cost: 'low',
    visibility: 'all',
    pack_tags: ['jeeves'],
};

function makeSkill(name: string, toolName: string): SkillManifest {
    return {
        name,
        description: `${name} skill`,
        version: '1.0.0',
        tools: [{ name: toolName, description: `${toolName} tool`, parameters: { type: Type.OBJECT } }],
        handlers: { [toolName]: vi.fn(async () => `${toolName} result`) },
    };
}

describe('skill tool registry', () => {
    it('binds each declaration to its handler, skill, and resolved metadata', async () => {
        const skill = makeSkill('memory', 'memory_remember');
        skill.meta = { ...defaults, cost: 'medium', pack_tags: ['jeeves', 'office'] };

        const registry = buildSkillToolRegistry([skill], defaults);
        const registration = registry.get('memory_remember');

        expect(registration?.skill).toBe(skill);
        expect(registration?.declaration).toBe(skill.tools[0]);
        expect(registration?.meta).toMatchObject({ cost: 'medium', pack_tags: ['jeeves', 'office'] });
        await expect(registration?.handler({}, undefined)).resolves.toBe('memory_remember result');
    });

    it('rejects declarations without matching handlers', () => {
        const skill = makeSkill('memory', 'memory_remember');
        skill.handlers = {};

        expect(() => buildSkillToolRegistry([skill], defaults)).toThrow(
            'Skill "memory" declares tool "memory_remember" without a handler.'
        );
    });

    it('rejects declarations without a name', () => {
        const skill = makeSkill('memory', 'memory_remember');
        skill.tools[0].name = '';

        expect(() => buildSkillToolRegistry([skill], defaults)).toThrow(
            'Skill "memory" contains a tool declaration without a name.'
        );
    });

    it('rejects handlers without matching declarations', () => {
        const skill = makeSkill('memory', 'memory_remember');
        skill.handlers.memory_forget = vi.fn(async () => 'forgotten');

        expect(() => buildSkillToolRegistry([skill], defaults)).toThrow(
            'Skill "memory" registers handler "memory_forget" without a declaration.'
        );
    });

    it('rejects duplicate tool names across skills', () => {
        const first = makeSkill('memory', 'shared_tool');
        const second = makeSkill('history', 'shared_tool');

        expect(() => buildSkillToolRegistry([first, second], defaults)).toThrow(
            'Duplicate tool "shared_tool" declared by skills "memory" and "history".'
        );
    });
});
