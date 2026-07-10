import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    formatContentCheckReport,
    listSkillCapabilityIds,
    validateContentRoots,
    validatePackRoot,
} from './content-validator';

const temporaryRoots: string[] = [];

function createFixtureRoot(): { root: string; packs: string; groundings: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-content-'));
    temporaryRoots.push(root);
    const packs = path.join(root, 'packs');
    const groundings = path.join(root, 'groundings');
    fs.mkdirSync(packs);
    fs.mkdirSync(groundings);
    return { root, packs, groundings };
}

function writeJsonDocument(filePath: string, meta: Record<string, unknown>, body: string): void {
    fs.writeFileSync(filePath, `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`);
}

function writeValidPack(packsRoot: string, id = 'example'): string {
    const root = path.join(packsRoot, id);
    fs.mkdirSync(root);
    writeJsonDocument(
        path.join(root, 'agent.md'),
        {
            id,
            persona_id: id,
            memory_rules: [],
            default_policies: {},
            authority_presets: {},
            seeded_tasks: [
                {
                    template_id: 'morning',
                    title: 'Morning note',
                    kind: 'assistant_prompt',
                    schedule_value: '0 9 * * *',
                    prompt: 'Write a morning note.',
                },
            ],
        },
        'You are an example assistant.'
    );
    writeJsonDocument(path.join(root, 'skills.md'), { enabled_capabilities: [] }, 'No optional skills.');
    return root;
}

function writeValidGrounding(groundingsRoot: string, id = 'example_world'): string {
    const root = path.join(groundingsRoot, id);
    fs.mkdirSync(root);
    writeJsonDocument(
        path.join(root, 'grounding.md'),
        { id, title: 'Example world', timezone: 'UTC', memory_focus: [], attention_bias: [] },
        'Stable world context.'
    );
    fs.writeFileSync(path.join(root, 'people.md'), 'No people yet.\n');
    fs.writeFileSync(path.join(root, 'operating.md'), 'Be useful.\n');
    return root;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installable content validator', () => {
    it('accepts complete packs and groundings', () => {
        const fixture = createFixtureRoot();
        writeValidPack(fixture.packs);
        writeValidGrounding(fixture.groundings);

        const checks = validateContentRoots(fixture);

        expect(checks).toHaveLength(2);
        expect(checks.every((item) => item.status === 'pass')).toBe(true);
        expect(formatContentCheckReport(checks)).toContain('Content is valid (2 items).');
    });

    it('reports schema errors and invalid schedules without crashing', () => {
        const fixture = createFixtureRoot();
        const packRoot = writeValidPack(fixture.packs, 'wrong-directory');
        const agentPath = path.join(packRoot, 'agent.md');
        writeJsonDocument(
            agentPath,
            {
                id: 'different-id',
                persona_id: '',
                memory_rules: ['work', 'work'],
                default_policies: {},
                authority_presets: {},
                seeded_tasks: [
                    {
                        template_id: 'bad',
                        title: 'Bad schedule',
                        kind: 'assistant_prompt',
                        schedule_value: 'not cron',
                        prompt: 'Run.',
                    },
                ],
            },
            'Prompt.'
        );

        const skillsPath = path.join(packRoot, 'skills.md');
        writeJsonDocument(skillsPath, { enabled_capabilities: ['unknown_skill'] }, 'Skills.');
        const result = validatePackRoot(packRoot, 'wrong-directory', new Set(['memory']));

        expect(result.status).toBe('fail');
        expect(result.message).toContain('must match directory');
        expect(result.message).toContain('persona_id is required');
        expect(result.message).toContain('memory_rules contains duplicates');
        expect(result.message).toContain('not a valid cron expression');
        expect(result.message).toContain('unknown enabled capabilities: unknown_skill');
    });

    it('reports missing required files and invalid tool exports', () => {
        const fixture = createFixtureRoot();
        const packRoot = writeValidPack(fixture.packs);
        fs.mkdirSync(path.join(packRoot, 'tools'));
        fs.writeFileSync(path.join(packRoot, 'tools', 'broken.tool.js'), 'module.exports = { id: "broken" };\n');
        const groundingRoot = path.join(fixture.groundings, 'incomplete');
        fs.mkdirSync(groundingRoot);
        writeJsonDocument(path.join(groundingRoot, 'grounding.md'), { id: 'incomplete', title: 'Incomplete' }, 'Body.');

        const checks = validateContentRoots(fixture);

        expect(checks.find((item) => item.kind === 'pack')?.message).toContain('Failed to load pack tool module');
        expect(checks.find((item) => item.kind === 'grounding')?.message).toContain('Missing required grounding file');
    });

    it('derives capability IDs from skill filenames without importing runtime modules', () => {
        const fixture = createFixtureRoot();
        const skills = path.join(fixture.root, 'skills');
        fs.mkdirSync(skills);
        fs.writeFileSync(path.join(skills, 'html-artifacts.skill.ts'), 'throw new Error("must not execute");\n');
        fs.writeFileSync(path.join(skills, 'memory.skill.js'), 'throw new Error("must not execute");\n');
        fs.writeFileSync(path.join(skills, 'README.md'), 'ignored\n');

        expect([...listSkillCapabilityIds(skills)].sort()).toEqual(['html_artifacts', 'memory']);
    });
});
