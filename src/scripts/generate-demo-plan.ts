import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, ensureTelegramSpace, upsertTask } from '../db';
import { createHtmlArtifactPage } from '../core/html-artifacts';

async function main() {
    // 1. Initialize DB
    initDatabase();
    ensureTelegramSpace('chat-1', 'group', 'chat-1');

    console.log('Database initialized. Seeding mock tasks for Bender...');

    // 2. Upsert some premium cron tasks for Bender (spaceId: telegram:chat-1)
    const spaceId = 'telegram:chat-1';

    // Task 1: Morning team briefing (completed today)
    upsertTask({
        id: 'task-morning-brief',
        space_id: spaceId,
        title: 'Утренний брифинг для команды',
        prompt: 'Generate daily agenda',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        last_run_at: new Date().toISOString(), // Completed today!
    });

    // Task 2: Email checks (pending)
    upsertTask({
        id: 'task-email-check',
        space_id: spaceId,
        title: 'Проверка почты и входящих',
        prompt: 'Check new messages',
        schedule_type: 'cron',
        schedule_value: '30 10 * * *',
        status: 'active',
        last_run_at: null, // Pending
    });

    // Task 3: Atelier sync (pending)
    upsertTask({
        id: 'task-atelier-sync',
        space_id: spaceId,
        title: 'Ателье синк',
        prompt: 'Sync ticket status',
        schedule_type: 'cron',
        schedule_value: '0 12 * * *',
        status: 'active',
        last_run_at: null, // Pending
    });

    // Task 4: Evening wrap-up (pending)
    upsertTask({
        id: 'task-evening-wrapup',
        space_id: spaceId,
        title: 'Вечерний отчет',
        prompt: 'Build daily report',
        schedule_type: 'cron',
        schedule_value: '0 18 * * *',
        status: 'active',
        last_run_at: null, // Pending
    });

    console.log('Generating agent plans...');

    // 3. Generate empty-body plan for Bender (loads from DB)
    const benderPage = createHtmlArtifactPage({
        spaceId: spaceId,
        kind: 'agent_plan',
        title: 'План дня Бэндера',
        body: '',
    });

    // 4. Generate checklist plan for Alice (loads from markdown body)
    const alicePage = createHtmlArtifactPage({
        spaceId: spaceId,
        kind: 'agent_plan',
        title: 'План дня Алисы',
        body: `- [ ] Составить план на день (09:00) [calendar, gmail]
- [x] Позавтракать и зарядиться кофе (08:00) [calendar]
- [ ] Проверить почту (10:00) [gmail]
- [ ] Написать отчет о проделанной работе (13:00) [docs, notion]
- [ ] Созвон по проекту (15:00) [calendar]`,
    });

    console.log('\n==================================================');
    console.log('Successfully generated premium agent_plan artifacts!');
    console.log('==================================================');
    console.log(`\n1. Bender's DB-derived Plan:\n   Path: ${benderPage.filePath}\n   URL: ${benderPage.url}`);
    console.log(`\n2. Alice's Markdown Plan:\n   Path: ${alicePage.filePath}\n   URL: ${alicePage.url}`);
    console.log('==================================================\n');

    // Copy generated files to artifacts directory for visual viewing/inspections by parent agent
    const brainArtifactsDir = '/Users/Amyote/.gemini/antigravity/brain/51178faf-ea44-4cb2-8f9b-93ae7d1903ca';
    const benderDest = path.join(brainArtifactsDir, 'bender_plan.html');
    const aliceDest = path.join(brainArtifactsDir, 'alice_plan.html');

    fs.copyFileSync(benderPage.filePath, benderDest);
    fs.copyFileSync(alicePage.filePath, aliceDest);

    console.log(`Copied plans to artifacts directory:\n- ${benderDest}\n- ${aliceDest}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
