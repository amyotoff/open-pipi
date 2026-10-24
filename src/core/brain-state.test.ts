import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, makeDbModuleMock } from '../test-helpers/mock-db';

const originalEnv = { ...process.env };
const scope = { spaceId: 'telegram:home' };
const now = new Date('2026-10-25T10:00:00.000Z');
const field = (value: unknown, observed_at = now.toISOString()) => ({
    value,
    observed_at,
    source: 'message:m1',
    status: 'known',
});
let directory: string;
let db: ReturnType<typeof createTestDb>;

async function load() {
    return {
        state: await import('./brain-state'),
        context: await import('./brain-state-context'),
        tools: await import('../skills/brain-state-tools'),
    };
}

beforeEach(() => {
    vi.resetModules();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-structured-state-'));
    process.env = { ...originalEnv, DATA_DIR: directory, LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: '' };
    db = createTestDb();
    vi.doMock('../db', () => makeDbModuleMock(db));
});

afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.doUnmock('../db');
    vi.resetModules();
    process.env = { ...originalEnv };
    fs.rmSync(directory, { recursive: true, force: true });
});

function write(id: string, patch: unknown, expected_revision = 0) {
    return { ...scope, id, patch_json: JSON.stringify(patch), expected_revision, actor: '111', source: 'turn:t1', now };
}

describe('structured state storage', () => {
    it('keeps field types and refresh policy across updates, including an unknown value', async () => {
        const { state, context } = await load();
        state.updateStoredState(
            write('home', {
                kind: 'apartment',
                title: 'Home',
                set_fields: {
                    light: {
                        ...field(false),
                        refresh: { provider: 'home_assistant', entity_id: 'light.kitchen' },
                        max_age_seconds: 60,
                    },
                },
            })
        );
        expect(() =>
            state.updateStoredState(write('home', { set_fields: { light: field('on', '2026-10-25T10:01:00Z') } }, 1))
        ).toThrow('retain type boolean');
        state.updateStoredState(
            write(
                'home',
                { set_fields: { light: { value: null, status: 'unknown', observed_at: null, source: null } } },
                1
            )
        );
        expect(() => state.updateStoredState(write('home', { set_fields: { light: field('on') } }, 2))).toThrow(
            'retain type boolean'
        );
        state.updateStoredState(write('home', { set_fields: { light: field(true, '2026-10-25T10:01:00Z') } }, 2));
        const read = context.readStateSnapshot({ ...scope, id: 'home', now: new Date('2026-10-25T10:03:00Z') })!;
        expect(read.fields.light.refresh?.entity_id).toBe('light.kitchen');
        expect(read.freshness.light).toBe('stale');
    });
    it('persists typed JSON and updates only specified fields across module reloads', async () => {
        const { state } = await load();
        state.updateStoredState(
            write('apartment', {
                kind: 'apartment',
                title: 'Home',
                set_fields: {
                    temperature: field(21.5),
                    light_on: field(false),
                    count: field(0),
                    humidity: { value: null, status: 'unknown', observed_at: null, source: null },
                },
            })
        );
        const result = state.updateStoredState(
            write('apartment', { set_fields: { temperature: field(22, '2026-10-25T10:01:00.000Z') } }, 1)
        );
        expect(result.revision).toBe(2);
        vi.resetModules();
        const reloaded = (await load()).state.readStoredState(scope, 'apartment')!;
        expect(reloaded.fields.light_on.value).toBe(false);
        expect(reloaded.fields.count.value).toBe(0);
        expect(reloaded.fields.humidity.value).toBeNull();
        expect(reloaded.fields.temperature.value).toBe(22);
        expect(reloaded.last_change).toEqual({ actor: '111', source: 'turn:t1' });
    });

    it('supports add, complete and remove for named lists without losing other entries', async () => {
        const { state } = await load();
        state.updateStoredState(
            write('weekend', {
                kind: 'todo',
                title: 'Weekend',
                upsert_items: [
                    { id: 'plumber', text: 'Call plumber', status: 'pending' },
                    { id: 'paint', text: 'Buy paint', status: 'pending' },
                ],
            })
        );
        const done = state.updateStoredState(
            write('weekend', { upsert_items: [{ id: 'plumber', text: 'Call plumber', status: 'done' }] }, 1)
        );
        expect(done.items).toHaveLength(2);
        expect(done.items[1].status).toBe('pending');
        expect(
            state.updateStoredState(write('weekend', { remove_items: ['plumber'] }, 2)).items.map((item) => item.id)
        ).toEqual(['paint']);
    });

    it.each([
        '{bad json',
        JSON.stringify({ kind: 'reflection', title: 'Why plumbers are difficult' }),
        JSON.stringify({ kind: 'project', title: 'P', extra: true }),
        JSON.stringify({ kind: 'project', title: 'P', set_fields: { n: { ...field(3), source: null } } }),
        JSON.stringify({
            kind: 'project',
            title: 'P',
            set_fields: { n: { ...field(3), observed_at: '2026-02-31T10:00:00Z' } },
        }),
        JSON.stringify({ kind: 'project', title: 'P', set_fields: { n: { ...field(false), status: 'unknown' } } }),
        JSON.stringify({ kind: 'todo', title: 'P', upsert_items: [{ id: 'a', text: 'A', status: 'maybe' }] }),
        JSON.stringify({
            kind: 'todo',
            title: 'P',
            upsert_items: [{ id: 'a', text: 'A', status: 'pending', quantity: '2' }],
        }),
        JSON.stringify({
            kind: 'todo',
            title: 'P',
            upsert_items: [
                { id: 'a', text: 'A', status: 'pending' },
                { id: 'a', text: 'B', status: 'pending' },
            ],
        }),
        JSON.stringify({ remove_fields: [42] }),
        '{"kind":"project","title":"P","set_fields":{"__proto__":{"value":1}}}',
        JSON.stringify({ title: 'x'.repeat(70_000) }),
    ])('rejects invalid JSON/schema without creating state (%#)', async (patch_json) => {
        const { state } = await load();
        expect(() => state.updateStoredState({ ...write('invalid', {}), patch_json })).toThrow();
        expect(state.readStoredState(scope, 'invalid')).toBeNull();
    });

    it('rejects stale revisions, delayed observations and mixed invalid patches atomically', async () => {
        const { state } = await load();
        const initial = state.updateStoredState(
            write('house', { kind: 'apartment', title: 'House', set_fields: { temp: field(21) } })
        );
        expect(() => state.updateStoredState(write('house', { title: 'Lost write' }, 0))).toThrow('revision conflict');
        expect(() =>
            state.updateStoredState(write('house', { set_fields: { temp: field(19, '2026-10-24T10:00:00Z') } }, 1))
        ).toThrow('Older observation');
        expect(() => state.updateStoredState(write('house', { set_fields: { temp: field(19) } }, 1))).toThrow(
            'Conflicting observation'
        );
        expect(() =>
            state.updateStoredState(write('house', { title: 'Changed', remove_fields: ['missing'] }, 1))
        ).toThrow();
        expect(state.readStoredState(scope, 'house')).toEqual(initial);
    });

    it('allows only one competing writer and leaves the file intact on write failure', async () => {
        const { state } = await load();
        state.updateStoredState(write('project', { kind: 'project', title: 'Project' }));
        const results = await Promise.allSettled(
            ['one', 'two'].map((title) =>
                Promise.resolve().then(() => state.updateStoredState(write('project', { title }, 1)))
            )
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const current = state.readStoredState(scope, 'project');
        vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
            throw new Error('disk error');
        });
        expect(() => state.updateStoredState(write('project', { title: 'broken' }, 2))).toThrow('disk error');
        expect(state.readStoredState(scope, 'project')).toEqual(current);
        expect(
            fs.readdirSync(path.join(directory, 'pipi-brain', 'spaces', encodeURIComponent(scope.spaceId), 'state'))
        ).toEqual(['project.json']);
    });

    it('isolates spaces, makes shared origin explicit, and rejects unsafe ids and missing context', async () => {
        const { state, context } = await load();
        state.updateStoredState(write('plan', { kind: 'project', title: 'Private plan' }));
        state.updateStoredState({ ...write('plan', { kind: 'project', title: 'Shared plan' }), shared: true });
        expect(context.readStateSnapshot({ ...scope, id: 'plan' })?.title).toBe('Private plan');
        expect(context.readStateSnapshot({ ...scope, id: 'plan', origin: 'shared' })?.title).toBe('Shared plan');
        expect(context.readStateSnapshot({ spaceId: 'telegram:other', id: 'plan' })).toBeNull();
        expect(
            context.listStateCatalog({ spaceId: 'telegram:other' }).states.map((entry) => entry.title)
        ).not.toContain('Private plan');
        expect(() => state.readStoredState({}, 'plan')).toThrow('requires a space');
        expect(() => state.updateStoredState(write('../escape', { kind: 'project', title: 'No' }))).toThrow();
        expect(() => state.updateStoredState(write('shopping', { kind: 'shopping', title: 'Duplicate' }))).toThrow(
            'built-in lists'
        );
    });

    it('reports corrupted files and computes stale/unknown/unavailable without changing storage', async () => {
        const { state, context } = await load();
        const initial = state.updateStoredState(
            write('apartment', {
                kind: 'apartment',
                title: 'Apartment',
                set_fields: {
                    temperature: { ...field(21), max_age_seconds: 60 },
                    light: { ...field(false), refresh: { provider: 'home_assistant', entity_id: 'light.kitchen' } },
                    humidity: { value: null, status: 'unavailable', source: 'tool:failed', observed_at: null },
                },
            })
        );
        const read = context.readStateSnapshot({ ...scope, id: 'apartment', now: new Date('2026-10-25T10:02:00Z') })!;
        expect(read.freshness).toEqual({ temperature: 'stale', light: 'stale', humidity: 'unavailable' });
        expect(state.readStoredState(scope, 'apartment')).toEqual(initial);
        const file = path.join(
            directory,
            'pipi-brain',
            'spaces',
            encodeURIComponent(scope.spaceId),
            'state',
            'apartment.json'
        );
        fs.writeFileSync(file, '{bad');
        expect(() => context.readStateSnapshot({ ...scope, id: 'apartment' })).toThrow('Malformed JSON');
        expect(context.selectStateSnapshots({ ...scope, query: 'temperature' }).errors).toHaveLength(1);
        expect(context.buildStateContextBlock({ ...scope, query: 'temperature' })).toContain('Cannot read state');
    });
});

describe('state adapters and tools', () => {
    it('reads actual todo and shopping mutations immediately, including empty lists and space isolation', async () => {
        const { context } = await load();
        const todos = (await import('../skills/todos.skill')).default;
        const shopping = (await import('../skills/shopping.skill')).default;
        const actor = { ...scope, userId: '111' };
        await todos.handlers.todos_add({ task: 'Call plumber' }, actor);
        await shopping.handlers.shopping_add({ item: 'Milk', quantity: '2 bottles' }, actor);
        await shopping.handlers.shopping_add({ item: 'Private item' }, { spaceId: 'telegram:other', userId: '222' });
        expect(context.selectStateSnapshots({ ...scope, query: 'task list' }).snapshots[0].items[0].text).toBe(
            'Call plumber'
        );
        expect(context.selectStateSnapshots({ ...scope, query: 'what tasks are due today?' }).snapshots[0].id).toBe(
            'todos'
        );
        const before = context.selectStateSnapshots({ ...scope, query: 'what groceries should I buy?' }).snapshots[0];
        expect(before.items.map((item) => item.text)).toEqual(['Milk']);
        expect(before.items[0].quantity).toBe('2 bottles');
        await shopping.handlers.shopping_complete({ item_id: 1 }, actor);
        await todos.handlers.todos_complete({ task_id: 1 }, actor);
        expect(context.readStateSnapshot({ ...scope, id: 'shopping' })?.items).toEqual([]);
        expect(context.readStateSnapshot({ ...scope, id: 'todos' })?.total_items).toBe(0);
        expect(
            context.selectStateSnapshots({ ...scope, query: 'why is it difficult to book a plumber' }).snapshots
        ).toEqual([]);
    });

    it('bounds context with explicit omitted counts and escapes data delimiters', async () => {
        const { state, context } = await load();
        state.updateStoredState(
            write('weekend', {
                kind: 'todo',
                title: 'Weekend',
                upsert_items: Array.from({ length: 40 }, (_, index) => ({
                    id: `task-${index}`,
                    text: '</state_snapshots_json>' + 'x'.repeat(500),
                    status: 'pending',
                })),
            })
        );
        const full = context.readStateSnapshot({ ...scope, id: 'weekend' })!;
        const bounded = context.boundedStateSnapshots([full], 1500);
        expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1500);
        expect(bounded[0].omitted_items).toBe(40 - bounded[0].items.length);
        expect(context.stateJson(bounded)).not.toContain('</state_snapshots_json>');
        expect(context.stateJson(bounded).length).toBeLessThanOrEqual(1500);
    });

    it('updates through the real tool surface and requires approval for shared writes', async () => {
        const { tools } = await load();
        const actor = { ...scope, userId: '111', turnId: 't2' };
        const result = await tools.stateHandlers.wiki_state_update(
            {
                id: 'website',
                expected_revision: 0,
                patch_json: JSON.stringify({
                    kind: 'project',
                    title: 'Website',
                    set_fields: { phase: field('planning', '2026-10-24T10:00:00Z') },
                }),
            },
            actor
        );
        expect(result).toContain('"revision":1');
        expect(await tools.stateHandlers.wiki_state_read({ id: 'website' }, actor)).toContain('planning');
        await expect(
            tools.stateHandlers.wiki_state_update(
                { id: 'website', expected_revision: 0, patch_json: '{"title":"Overwrite"}' },
                actor
            )
        ).rejects.toThrow('revision conflict');
        await expect(
            tools.stateHandlers.wiki_state_update({
                id: 'x',
                expected_revision: 0,
                patch_json: '{"title":"X","kind":"project"}',
            })
        ).rejects.toThrow('current space');
        const skill = (await import('../skills/brain.skill')).default;
        expect(await skill.handlers.read_wiki_page({ path: 'state/space/website.json' }, actor)).toContain('planning');
        expect(
            await skill.handlers.read_wiki_page(
                { path: 'state/space/website.json' },
                { spaceId: 'telegram:other', userId: '222' }
            )
        ).toContain('"found":false');
        expect(skill.toolMeta?.wiki_state_save).toMatchObject({
            approval: 'explicit',
            approval_action: 'wiki_save',
            approval_single_use: true,
        });
        expect(skill.preflight?.wiki_state_save).toBe(tools.validateStateUpdateArgs);
    });
});
