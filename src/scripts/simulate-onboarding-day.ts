// All env must be configured before any import reads process.env (import hoisting).
const _path = require('path');
process.env.DATA_DIR = _path.resolve(__dirname, '../../data-onboarding-sim');
process.env.PIPI_PLATFORM = 'generic';
require('dotenv').config({ path: _path.resolve(__dirname, '../../../NewsDispatch/.env.local') });

import { initDatabase, getDb, upsertResident, storeMessage } from '../db';
import { handleButlerMessage } from '../agents/butler';
import { registerChannel } from '../channels/_registry';
import { initAllSkills } from '../skills/_registry';

const sentMessages: Array<{ sender: string; text: string }> = [];

// Register a test channel to capture responses
registerChannel('test_channel' as any, () => ({
    type: 'telegram' as any,
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async (ref: string, text: string) => {
        console.log(`\n[Бот]: ${text}`);
        sentMessages.push({ sender: 'PiPi', text });
        return { success: true };
    },
}));

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function emit(senderId: string, name: string, text: string) {
    console.log(`\n[${name}]: ${text}`);
    sentMessages.push({ sender: name, text });

    storeMessage({
        id: `msg-${Date.now()}-${name}`,
        space_id: 'test_channel:office',
        chat_jid: 'office',
        sender_tg_id: senderId,
        content: text,
        timestamp: new Date().toISOString(),
        is_bot: 0,
    });

    await handleButlerMessage({
        channel: 'test_channel',
        channelRef: 'office',
        senderId: senderId,
        text,
        spaceId: 'test_channel:office',
    });

    await sleep(8000);
}

async function main() {
    initDatabase();
    await initAllSkills();
    const db = getDb();

    // Set up space — created_at = NOW (fresh space, onboarding should be active)
    const now = new Date().toISOString();
    db.prepare(
        `INSERT OR IGNORE INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        'test_channel:office',
        'group_chat',
        'Marketing Agency (Onboarding)',
        'test_channel',
        'office',
        'ACTIVE',
        'office',
        '{"tasks":true,"browser":true}',
        now,
        now
    );

    // Add residents
    const characters = [
        { tg_id: '111', username: 'alice', display_name: 'Алиса', role: 'owner' },
        { tg_id: '222', username: 'bob', display_name: 'Боб', role: 'member' },
        { tg_id: '333', username: 'bender', display_name: 'Бендер', role: 'member' },
    ];
    for (const c of characters) {
        upsertResident(c);
        db.prepare(
            `INSERT OR IGNORE INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            'test_channel:office',
            c.tg_id,
            c.role,
            c.role === 'owner' ? 1000 : 100,
            0,
            c.role === 'owner'
                ? JSON.stringify({
                      can_assign_tasks: true,
                      can_change_policies: true,
                      can_override_instructions: true,
                      can_issue_high_impact_commands: true,
                  })
                : '{}',
            c.role,
            now,
            now
        );
    }

    console.log('=== ONBOARDING SIMULATION START ===\n');
    console.log('Space created just now. Bot should be in curiosity mode.\n');

    // Scene 1: Vague task that should trigger a curiosity question
    await emit('111', 'Алиса', 'Боб, подготовь рассылку для клиента.');

    // Scene 2: Bob shares some info, bot should record it
    await emit('222', 'Боб', 'Я обычно использую Mailchimp для рассылок. Шаблоны лежат в Google Drive.');

    // Scene 3: Direct request for bot to summarize what it knows
    await emit('111', 'Алиса', 'Бот, что ты уже знаешь о нашей команде?');

    // Print summary
    console.log('\n\n=== ONBOARDING SIMULATION COMPLETE ===');
    console.log('\nTranscript:');
    for (const m of sentMessages) {
        console.log(`**${m.sender}**: ${m.text}\n`);
    }

    process.exit(0);
}

main().catch(console.error);
