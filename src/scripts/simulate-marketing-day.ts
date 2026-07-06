import { config } from 'dotenv';
import { resolve } from 'path';

// Force an isolated DB for this test
process.env.DATA_DIR = resolve(__dirname, '../../data-marketing-sim');
config({ path: resolve(__dirname, '../../../NewsDispatch/.env.local') });
process.env.PIPI_PLATFORM = 'generic';

import { initDatabase, getDb, upsertResident, storeMessage } from '../db';
import { handleButlerMessage } from '../agents/butler';
import { registerChannel } from '../channels/_registry';

const sentMessages: Array<{ sender: string; text: string }> = [];

// Register a test channel to capture responses
registerChannel('test_channel' as any, () => ({
    type: 'telegram' as any,
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async (ref, text, _opts) => {
        console.log(`\n[Бот]: ${text}`);
        sentMessages.push({ sender: 'PiPi', text });
        return { success: true };
    },
}));

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// Function to emit a normal message
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

    await sleep(6000); // give gemini time to reply
}

async function main() {
    initDatabase();
    const db = getDb();

    // Set up space
    db.prepare(
        `INSERT OR IGNORE INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        'test_channel:office',
        'group_chat',
        'Marketing Agency',
        'test_channel',
        'office',
        'ACTIVE',
        'office',
        '{"tasks":true,"browser":true}',
        new Date().toISOString(),
        new Date().toISOString()
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
            `INSERT OR IGNORE INTO memberships (space_id, person_id, role, base_authority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
            'test_channel:office',
            c.tg_id,
            c.role,
            c.role === 'owner' ? 1000 : 100,
            new Date().toISOString(),
            new Date().toISOString()
        );
    }

    console.log('Starting marketing agency simulation...\n');

    await emit('111', 'Алиса', 'Всем привет! У нас сегодня брифинг по запуску рассылки Acme Corp.');
    await emit(
        '222',
        'Боб',
        'Привет! Я должен сделать рассылку для Acme Corp, но жду тексты от копирайтеров. Бот, создай мне задачу на сегодня: написать рассылку Acme Corp.'
    );
    await emit('333', 'Бендер', 'Парсинг аудитории для Acme завершен. Бот, зафиксируй это событие.');
    await emit('111', 'Алиса', 'Отлично. Бот, подсвети всем план на день.');

    // Write out the result!
    const logText = sentMessages.map((m) => `**${m.sender}**: ${m.text}`).join('\n\n');
    console.log('\n\n[SIMULATION_DONE_SIG]\n' + logText);

    process.exit(0);
}

main().catch(console.error);
