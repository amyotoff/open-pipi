import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const ORIGINAL_ENV = { ...process.env };

async function loadSkill(options: { publicBaseUrl?: string; sendFileSuccess?: boolean } = {}) {
    vi.resetModules();
    const sendChannelFile = vi.fn(async () => ({
        success: options.sendFileSuccess !== false,
        messageId: 'file-1',
        error: options.sendFileSuccess === false ? 'not supported' : undefined,
    }));

    vi.doMock('../channels/runtime', () => ({ sendChannelFile }));
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-html-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...(options.publicBaseUrl === undefined ? { PIPI_PUBLIC_BASE_URL: 'https://pipi.example' } : {}),
    };
    if (options.publicBaseUrl !== undefined) {
        process.env.PIPI_PUBLIC_BASE_URL = options.publicBaseUrl;
    }

    const db = await import('../db');
    db.initDatabase();
    db.ensureTelegramSpace('chat-1', 'group', 'chat-1');
    const skill = (await import('./html-artifacts.skill')).default;
    return { db, skill, sendChannelFile };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('html-artifacts skill', () => {
    it('creates a shareable HTML artifact for the current space', async () => {
        const { skill } = await loadSkill();

        const result = await skill.handlers.html_artifact_create(
            {
                kind: 'work_plan',
                title: 'Migration Plan',
                summary: 'A compact execution plan.',
                body: '**Steps**\n- 10:00 sync with team\n- Ship the MVP',
            },
            {
                channel: 'telegram',
                channelRef: 'chat-1',
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
            }
        );

        expect(result).toContain('[TOOL_RESULT] HTML artifact created: https://pipi.example/html/');
        expect(result).toContain('.html');
    });

    it('lists recently created HTML artifacts', async () => {
        const { skill } = await loadSkill();

        await skill.handlers.html_artifact_create(
            {
                kind: 'brief',
                title: 'Readable Brief',
                body: '**Today**\n- One useful thing',
            },
            {
                channel: 'telegram',
                channelRef: 'chat-1',
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
            }
        );

        const result = await skill.handlers.html_artifact_list({ limit: 5 });

        expect(result).toContain('[TOOL_RESULT] Recent HTML artifacts:');
        expect(result).toContain('https://pipi.example/html/');
        expect(result).toContain('.html');
    });

    it('creates a shareable kanban board artifact', async () => {
        const { skill } = await loadSkill();

        const result = await skill.handlers.html_artifact_create(
            {
                kind: 'kanban_board',
                title: 'Team Board',
                body: '## To do\n- Write brief\n\n## In progress\n- Review draft\n\n## Done\n- Create ticket',
            },
            {
                channel: 'telegram',
                channelRef: 'chat-1',
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
            }
        );

        const htmlArtifacts = await import('../core/html-artifacts');
        const [page] = htmlArtifacts.listHtmlArtifactPages(1);
        const html = fs.readFileSync(page.filePath, 'utf8');

        expect(result).toContain('https://pipi.example/html/');
        expect(page.fileName).toContain('kanban_board');
        expect(html).toContain('class="kanban-board"');
        expect(html).toContain('data-status="doing"');
        expect(html).toContain('Review draft');
    });

    it('attaches the HTML artifact when no public URL is configured', async () => {
        const { skill, sendChannelFile } = await loadSkill({ publicBaseUrl: '' });

        const result = await skill.handlers.html_artifact_create(
            {
                kind: 'research',
                title: 'Local Research',
                body: '**Findings**\n- One useful thing',
            },
            {
                channel: 'telegram',
                channelRef: 'chat-1',
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
            }
        );

        expect(result).toContain('[TOOL_RESULT] HTML artifact created and attached to the chat');
        expect(sendChannelFile).toHaveBeenCalledWith(
            'telegram',
            'chat-1',
            expect.stringContaining('/html-artifacts/'),
            expect.objectContaining({
                caption: 'HTML artifact: Local Research',
            })
        );
    });

    it('creates a premium agent_plan artifact from markdown body', async () => {
        const { skill } = await loadSkill();

        const result = await skill.handlers.html_artifact_create(
            {
                kind: 'agent_plan',
                title: "Alice's Day Plan",
                body: '- [ ] Составить план (09:00) [calendar, gmail]\n- [x] Позавтракать (08:00) [calendar]\n- [ ] Проверить почту (10:00) [gmail]\n- [ ] Написать отчет (13:00) [docs]',
            },
            {
                channel: 'telegram',
                channelRef: 'chat-1',
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
            }
        );

        const htmlArtifacts = await import('../core/html-artifacts');
        const [page] = htmlArtifacts.listHtmlArtifactPages(1);
        const html = fs.readFileSync(page.filePath, 'utf8');

        expect(result).toContain('https://pipi.example/html/');
        expect(page.fileName).toContain('agent_plan');
        expect(html).toContain('class="agent-plan-theme"');
        expect(html).toContain('Outfit');
        expect(html).toContain('is-completed'); // The checked item should have is-completed class
        expect(html).toContain('Позавтракать');
        expect(html).toContain('08:00');
        expect(html).toContain('Google Calendar');
        expect(html).toContain('Gmail');
        expect(html).toContain('Google Docs');
        expect(html).toContain('Все задачи');
    });

    it('creates a premium agent_plan artifact by querying active scheduled tasks from the DB when body is empty', async () => {
        const { skill, db } = await loadSkill();

        // Register active cron tasks in SQLite
        db.upsertTask({
            id: 'task-morning-brief',
            space_id: 'telegram:chat-1',
            title: 'Утренний брифинг',
            prompt: 'Summarize news',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            status: 'active',
            last_run_at: new Date().toISOString(), // Completed today
        });
        db.upsertTask({
            id: 'task-atelier-sync',
            space_id: 'telegram:chat-1',
            title: 'Ателье синк',
            prompt: 'Sync ticket status',
            schedule_type: 'cron',
            schedule_value: '30 11 * * *',
            status: 'active',
            last_run_at: null, // Pending
        });

        const result = await skill.handlers.html_artifact_create(
            {
                kind: 'agent_plan',
                title: "Bender's Schedule",
                body: '', // Empty body
            },
            {
                channel: 'telegram',
                channelRef: 'chat-1',
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
            }
        );

        const htmlArtifacts = await import('../core/html-artifacts');
        const [page] = htmlArtifacts.listHtmlArtifactPages(1);
        const html = fs.readFileSync(page.filePath, 'utf8');

        expect(result).toContain('https://pipi.example/html/');
        expect(html).toContain('class="agent-plan-theme"');
        expect(html).toContain('Утренний брифинг');
        expect(html).toContain('09:00');
        expect(html).toContain('is-completed'); // completed today
        expect(html).toContain('Ателье синк');
        expect(html).toContain('11:30'); // 30 11 -> 11:30
        expect(html).not.toContain('task-atelier-sync.is-completed');
    });
});
