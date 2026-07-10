import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDb, makeDbModuleMock, seedResident } from '../test-helpers/mock-db';

let db: Database.Database;

async function loadSkill<T>(modulePath: string, setupMocks?: () => void): Promise<T> {
    vi.resetModules();
    vi.doMock('../db', () => makeDbModuleMock(db));
    setupMocks?.();
    return (await import(modulePath)) as T;
}

async function loadOperatorCommands() {
    vi.resetModules();
    vi.doUnmock('../utils/approvals');
    vi.doMock('../db', () => makeDbModuleMock(db));
    vi.doMock('../skills/_registry', () => ({
        getRegisteredHandlers: () => ({
            pipi_status: vi.fn(async () => '[TOOL_RESULT] setup status body'),
            pipi_apply_defaults: vi.fn(async () => '[TOOL_RESULT] defaults applied'),
            pipi_smoke: vi.fn(async () => '[TOOL_RESULT] smoke body'),
        }),
    }));
    vi.doMock('../channels/_registry', () => ({
        getChannel: vi.fn(() => ({ isConnected: () => true })),
    }));
    return await import('../channels/operator-commands');
}

beforeEach(() => {
    db = createTestDb();
    seedResident(db, { tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
});

afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('feature smokes', () => {
    it('shopping smoke', async () => {
        const { default: skill } = await loadSkill<any>('./shopping.skill');
        expect(
            await skill.handlers.shopping_add({ item: 'Coffee beans' }, { chatId: 'chat-1', userId: '111' })
        ).toContain('Added');
    });

    it('todos smoke', async () => {
        const { default: skill } = await loadSkill<any>('./todos.skill');
        expect(await skill.handlers.todos_add({ task: 'Pay bills' }, { chatId: 'chat-1', userId: '111' })).toContain(
            'Added'
        );
    });

    it('reminders smoke', async () => {
        const { default: skill } = await loadSkill<any>('./reminders.skill');
        expect(
            await skill.handlers.reminder_set(
                { content: 'Stretch', remind_at: new Date().toISOString() },
                { chatId: 'chat-1', userId: '111' }
            )
        ).toContain('Reminder set');
    });

    it('memory smoke', async () => {
        const { default: skill } = await loadSkill<any>('./memory.skill');
        expect(
            await skill.handlers.memory_remember({ resident_name: 'Alice', fact: 'likes tea', category: 'preference' })
        ).toContain('Remembered');
    });

    it('browsing smoke', async () => {
        const { default: skill } = await loadSkill<any>('./browsing.skill', () => {
            vi.doMock('../utils/search', () => ({ searchAndSummarize: vi.fn(async () => 'result') }));
            vi.doMock('../utils/browser', () => ({
                assertSafeBrowserUrl: vi.fn(async (url: string) => url),
                withBrowserContext: vi.fn(async (action: any) =>
                    action({
                        newPage: async () => ({
                            setDefaultNavigationTimeout: vi.fn(),
                            goto: vi.fn(),
                            evaluate: vi.fn(async () => 'page text'),
                            close: vi.fn(),
                        }),
                    })
                ),
            }));
        });
        expect(
            await skill.handlers.browse_web({ url: 'https://example.com' }, { chatId: 'chat-1', userId: '111' })
        ).toContain('<WEB_CONTENT>');
    });

    it('webrun smoke', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            functionCalls: [],
            text: 'final',
        });
        const { default: skill } = await loadSkill<any>('./webrun.skill', () => {
            vi.doMock('../utils/search', () => ({ searchAndSummarize: vi.fn(async () => 'result') }));
            vi.doMock('../utils/browser', () => ({
                assertSafeBrowserUrl: vi.fn(async (url: string) => url),
                withBrowserContext: vi.fn(),
            }));
            vi.doMock('../config', async (importOriginal) => {
                const actual = await importOriginal<typeof import('../config')>();
                return {
                    ...actual,
                    GEMINI_API_KEY: 'test',
                };
            });
            vi.doMock('@google/genai', () => ({
                GoogleGenAI: class {
                    models = { generateContent };
                },
                Type: { OBJECT: 'object', STRING: 'string' },
            }));
        });
        expect(
            await skill.handlers.webrun_execute({ task: 'test research' }, { chatId: 'chat-1', userId: '111' })
        ).toContain('final');
    });

    it('tasks smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            JSON.stringify({ tasks: true }),
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        const { default: skill } = await loadSkill<any>('./tasks.skill', () => {
            vi.doMock('../agents/butler', () => ({ handleButlerMessage: vi.fn(async () => undefined) }));
            vi.doMock('../channels/telegram', () => ({ sendMessageToChat: vi.fn(async () => undefined) }));
        });
        expect(
            await skill.handlers.task_create(
                { title: 'Digest', prompt: 'Write a digest.', cron_expression: '0 8 * * 1' },
                { chatId: 'chat-1', userId: '111' }
            )
        ).toContain('Scheduled task created');
        const task = db.prepare('SELECT id FROM tasks WHERE title = ?').get('Digest') as any;
        expect(await skill.handlers.task_run_now({ task_id: task.id }, { chatId: 'chat-1', userId: '111' })).toContain(
            'ran successfully'
        );
    });

    it('projects smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./projects.skill');
        expect(
            await skill.handlers.project_create(
                { title: 'Firebreak', goal: 'Stabilize the memo', next_step: 'Write the shortlist' },
                { chatId: 'chat-1', userId: '111' }
            )
        ).toContain('Created project');
        expect(await skill.handlers.project_done({}, { chatId: 'chat-1', userId: '111' })).toContain('now done');
    });

    it('members smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        const { default: skill } = await loadSkill<any>('./members.skill');
        expect(await skill.handlers.member_list({}, { chatId: 'chat-1', userId: '111' })).toContain('111');
    });

    it('atelier smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        const { default: skill } = await loadSkill<any>('./atelier.skill');
        expect(
            await skill.handlers.atelier_request_capability(
                {
                    capability_gap: 'gmail_thread_triage',
                    description: 'Need inbox triage for the office team.',
                    user_request: 'Sort and archive inbox threads.',
                },
                { chatId: 'chat-1', userId: '111' }
            )
        ).toContain('gmail_thread_triage');
        expect(
            await skill.handlers.atelier_create_ticket(
                {
                    request_id: 1,
                },
                { chatId: 'chat-1', userId: '111' }
            )
        ).toContain('[IMPLEMENTATION_TICKET ATL-1]');
    });

    it('grounding smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Personal',
            'telegram',
            'chat-1',
            'ACTIVE',
            'jeeves',
            'jeeves_personal',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./grounding.skill');
        expect(await skill.handlers.grounding_status({}, { chatId: 'chat-1', userId: '111' })).toContain(
            'Office Coordination'
        );
        expect(
            await skill.handlers.grounding_add_override(
                {
                    kind: 'place',
                    subject: 'Family home',
                    content: 'The family now lives in Tbilisi.',
                },
                { chatId: 'chat-1', userId: '111' }
            )
        ).toContain('Tbilisi');
    });

    it('setup facade smoke', async () => {
        const commands = await loadOperatorCommands();

        const initial = await commands.runSetupTelegramCommand({
            chatId: 'setup-chat',
            chatType: 'private',
            userId: '111',
            text: '/setup',
        });
        expect(initial).toContain('Setup state: new');
        expect(initial).toContain('/setup apply');

        const applied = await commands.runSetupTelegramCommand({
            chatId: 'setup-chat',
            chatType: 'private',
            userId: '111',
            text: '/setup apply',
        });
        expect(applied).toContain('defaults applied');
        expect(applied).toContain('Setup state: active');

        const smoke = await commands.runSetupTelegramCommand({
            chatId: 'setup-chat',
            chatType: 'private',
            userId: '111',
            text: '/setup smoke',
        });
        expect(smoke).toContain('smoke body');

        const reset = await commands.runSetupTelegramCommand({
            chatId: 'setup-chat',
            chatType: 'private',
            userId: '111',
            text: '/setup reset',
        });
        expect(reset).toContain('Setup state reset to new');
    });

    it('channel smoke', async () => {
        const commands = await loadOperatorCommands();
        const context = {
            chatId: 'channel-chat',
            chatType: 'group',
            userId: '111',
        };

        const initial = await commands.runChannelTelegramCommand({
            ...context,
            text: '/channel status',
        });
        expect(initial).toContain('Mode: full');

        expect(
            await commands.runChannelTelegramCommand({
                ...context,
                text: '/channel mode inbox',
            })
        ).toContain('"inbox"');
        expect(
            await commands.runChannelTelegramCommand({
                ...context,
                text: '/channel mode notify_only',
            })
        ).toContain('"notify_only"');
        expect(
            await commands.runChannelTelegramCommand({
                ...context,
                text: '/channel mode off',
            })
        ).toContain('"off"');
        expect(
            await commands.runChannelTelegramCommand({
                ...context,
                text: '/channel mode full',
            })
        ).toContain('"full"');
    });

    it('approval smoke', async () => {
        const commands = await loadOperatorCommands();
        const approvals = await import('../utils/approvals');

        const singleScope = {
            chatId: 'approval-single',
            userId: '111',
            spaceId: 'telegram:approval-single',
        };
        expect(approvals.requireToolApproval('browse_web', singleScope, 'Need to open example.com')).toContain(
            'browse_web'
        );
        expect(approvals.recordApprovalResponse(singleScope, 'да')).toEqual({
            granted: ['browse_web'],
            denied: [],
        });
        expect(approvals.requireToolApproval('browse_web', singleScope, 'Need to open example.com again')).toBeNull();

        const multiScope = {
            chatId: 'approval-multi',
            userId: '111',
            spaceId: 'telegram:approval-multi',
        };
        approvals.requireToolApproval('browse_web', multiScope, 'Need a browser session');
        approvals.requireToolApproval('webrun_execute', multiScope, 'Need deeper research');

        expect(approvals.recordApprovalResponse(multiScope, 'да')).toEqual({
            granted: [],
            denied: [],
        });

        expect(
            commands.runApprovalTelegramCommand('approve', {
                chatId: 'approval-multi',
                chatType: 'private',
                userId: '111',
                text: '/approve browse_web',
            })
        ).toContain('Approved: browse_web.');
    });

    it('workspace smoke', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-workspace-smoke-'));
        try {
            fs.writeFileSync(path.join(workspaceRoot, 'README.txt'), 'workspace smoke', 'utf-8');
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                'group_chat',
                'Workspace Team',
                'telegram',
                'chat-1',
                'ACTIVE',
                'office',
                JSON.stringify({ workspace_path: workspaceRoot }),
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: skill } = await loadSkill<any>('./workspace.skill');
            expect(await skill.handlers.workspace_status({}, { chatId: 'chat-1', userId: '111' })).toContain(
                workspaceRoot
            );
            expect(
                await skill.handlers.workspace_find_files({ query: 'readme' }, { chatId: 'chat-1', userId: '111' })
            ).toContain('README.txt');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('workflows smoke', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-workflow-smoke-'));
        try {
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                'group_chat',
                'Editorial',
                'telegram',
                'chat-1',
                'ACTIVE',
                'reporter',
                JSON.stringify({ workspace_path: workspaceRoot }),
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: skill } = await loadSkill<any>('./workflows.skill');
            expect(await skill.handlers.workflow_list_templates({}, { chatId: 'chat-1', userId: '111' })).toContain(
                'reporter_brief'
            );
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('artifacts smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Art',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            '{}',
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./artifacts.skill');

        // Create
        const createRes = await skill.handlers.artifacts_create(
            {
                kind: 'plan',
                title: 'Test Plan',
                ref: 'Step 1',
                summary: 'A simple plan.',
            },
            { chatId: 'chat-1', userId: '111' }
        );
        expect(createRes).toContain('created successfully');

        // List
        const listRes = await skill.handlers.artifacts_list({}, { chatId: 'chat-1', userId: '111' });
        expect(listRes).toContain('Test Plan');
        expect(listRes).not.toContain('Journal');
        const journalArtifact = db.prepare(`SELECT * FROM artifacts WHERE kind = 'journal_day' LIMIT 1`).get() as any;
        expect(journalArtifact?.title).toContain('Journal ');

        // Extract ID (naive)
        const idMatch = listRes.match(/\[(art_[^\]]+)\]/);
        expect(idMatch).toBeTruthy();
        const id = idMatch![1];

        // Update
        const updateRes = await skill.handlers.artifacts_update(
            { id, ref: 'Step 1, Step 2' },
            { chatId: 'chat-1', userId: '111' }
        );
        expect(updateRes).toContain('updated successfully');

        // Archive
        const archiveRes = await skill.handlers.artifacts_archive({ id }, { chatId: 'chat-1', userId: '111' });
        expect(archiveRes).toContain('has been archived');

        // List again (empty)
        const emptyListRes = await skill.handlers.artifacts_list({}, { chatId: 'chat-1', userId: '111' });
        expect(emptyListRes).toContain('No active artifacts');

        // Rotation
        await skill.handlers.artifacts_create(
            { kind: 'plan', title: 'P2', ref: 'X', summary: 'Y' },
            { chatId: 'chat-1', userId: '111' }
        );
        const p3 = await skill.handlers.artifacts_create(
            { kind: 'plan', title: 'P3', ref: 'X', summary: 'Y' },
            { chatId: 'chat-1', userId: '111' }
        );
        expect(p3).toContain('were archived');

        const finalCheck = await skill.handlers.artifacts_list({}, { chatId: 'chat-1', userId: '111' });
        expect(finalCheck).toContain('P3');
        expect(finalCheck).not.toContain('P2');
    });

    it('journal smoke', async () => {
        const now = new Date().toISOString();
        const parts = Object.fromEntries(
            new Intl.DateTimeFormat('en-GB', {
                timeZone: process.env.TZ || 'UTC',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            })
                .formatToParts(new Date(now))
                .filter((part) => part.type !== 'literal')
                .map((part) => [part.type, part.value])
        );
        const today = `${parts.year}-${parts.month}-${parts.day}`;
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run('telegram:chat-1', 'group_chat', 'Journal', 'telegram', 'chat-1', 'ACTIVE', 'office', '{}', now, now);
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run('telegram:chat-1', '111', 'owner', 1000, 0, '{}', 'owner', now, now);
        db.prepare(
            `
            INSERT INTO timeline_events (id, space_id, day, happened_at, type, ref_type, ref_id, summary, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'tl_test',
            'telegram:chat-1',
            today,
            now,
            'artifact.created',
            'artifact_db',
            'art_1',
            'Created plan artifact "Test Plan".',
            '{}',
            now
        );

        const { default: skill } = await loadSkill<any>('./journal.skill');
        const result = await skill.handlers.journal_view({ range: 'today' }, { chatId: 'chat-1', userId: '111' });
        expect(result).toContain(`Today (${today})`);
        expect(result).toContain('Created plan artifact');
    });

    it('helper smoke', async () => {
        const { default: skill } = await loadSkill<any>('./helper.skill');
        const lookup = await skill.handlers.helper_lookup({ topic: 'packs' }, { chatId: 'chat-1', userId: '111' });
        expect(lookup).toContain('[TOOL_RESULT] Help reference');
        expect(lookup).toContain('help.md');
        expect(lookup).toContain('README.md');
        expect(lookup).toContain('pack');

        const directHelp = await skill.handlers.help_lookup(
            { topic: 'channel modes' },
            { chatId: 'chat-1', userId: '111' }
        );
        expect(directHelp).toContain('[TOOL_RESULT] Help reference');
        expect(directHelp).toContain('Channel modes');
        expect(directHelp).toContain('README.md');
    });

    it('helper status smoke', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Personal',
            'telegram',
            'chat-1',
            'ACTIVE',
            'jeeves',
            'jeeves_personal',
            JSON.stringify({ tasks: true }),
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '222',
            'member',
            0,
            0,
            JSON.stringify({}),
            'member',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./helper_status.skill');
        expect(await skill.handlers.helper_self_status({}, { chatId: 'chat-1', userId: '222' })).toContain(
            'Only owners can see runtime status'
        );
        expect(await skill.handlers.helper_self_status({}, { chatId: 'chat-1', userId: '111' })).toContain(
            '[TOOL_RESULT] Self status'
        );
    });
});
