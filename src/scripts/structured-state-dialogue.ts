/** Opt-in live evaluation: node --env-file=.env.local -r ts-node/register src/scripts/structured-state-dialogue.ts */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
    assert(process.env.OPENAI_API_KEY, 'An explicitly approved OPENAI_API_KEY is required.');
    const root = path.resolve('.tmp');
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'state-dialogue-'));
    Object.assign(process.env, {
        DATA_DIR: directory,
        DB_PATH: path.join(directory, 'evaluation.db'),
        LLM_PROVIDER: 'openai',
        LLM_TOOLS_PROVIDER: 'openai',
        LLM_EXECUTOR_MODEL: 'gpt-4.1-mini',
        PIPI_ADVISOR_ENABLED: 'false',
        PIPI_LOCAL_ROUTING_ENABLED: 'false',
    });
    const db = await import('../db');
    const { composeConversationContext } = await import('../core/context-composer');
    const { processWithLLM } = await import('../core/llm');
    const { readStateSnapshot } = await import('../core/brain-state-context');
    db.initDatabase();
    const userId = 'state-evaluation-user';
    db.upsertResident({ tg_id: userId, display_name: 'Memory evaluation', role: 'owner' });
    const space = db.ensureSpace('web', 'state-evaluation', { kind: 'direct_chat', assistant_pack_id: 'jeeves' });
    db.ensureSpaceMembership(space.id, userId, 'owner');
    db.updateSpacePolicy(space.id, { onboarding_complete: true });
    const transcript: unknown[] = [];
    const state = () =>
        ['todos', 'shopping'].map((id) => readStateSnapshot({ spaceId: space.id, id, origin: 'native' }));
    const pending = () => state().map((s) => s!.items.map((item) => item.text.toLowerCase()).sort());
    let turn = 0;
    async function say(content: string) {
        turn++;
        db.storeMessage({
            id: `user-${turn}`,
            space_id: space.id,
            channel: 'web',
            channel_ref: 'state-evaluation',
            sender_id: userId,
            content,
            timestamp: new Date().toISOString(),
            is_bot: 0,
        });
        const composed = composeConversationContext({ spaceId: space.id, senderId: userId });
        const reply = await processWithLLM(composed.llmMessages, {
            userId,
            spaceId: space.id,
            channel: 'web',
            channelRef: 'state-evaluation',
            turnId: `eval-${turn}`,
            allowedTools: [
                'todos_add',
                'todos_list',
                'todos_complete',
                'shopping_add',
                'shopping_list',
                'shopping_complete',
                'wiki_state_list',
                'wiki_state_read',
                'wiki_state_update',
                'read_wiki_page',
                'wiki_search',
                'wiki_schema',
                'append_note',
                'update_wiki_page',
            ],
        });
        db.storeMessage({
            id: `assistant-${turn}`,
            space_id: space.id,
            channel: 'web',
            channel_ref: 'state-evaluation',
            content: reply.text,
            timestamp: new Date().toISOString(),
            is_bot: 1,
        });
        transcript.push({ user: content, assistant: reply.text, state: state(), system_prompt: composed.systemPrompt });
        fs.writeFileSync(path.join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2));
        console.log(JSON.stringify({ turn, user: content, assistant: reply.text, pending: pending() }));
        return { reply: reply.text, prompt: composed.systemPrompt };
    }
    console.log(`Live evaluation artifacts: ${directory}`);
    await say(
        'Please reply in English throughout this conversation. Add these tasks: call the clinic; pay the internet bill. Add milk and bread to the shopping list.'
    );
    assert.deepEqual(pending(), [
        ['call the clinic', 'pay the internet bill'],
        ['bread', 'milk'],
    ]);
    await say('I called the clinic and bought the milk. Mark the task completed and the milk purchased.');
    assert.deepEqual(pending(), [['pay the internet bill'], ['bread']]);
    const remaining = await say('What tasks and shopping items remain?');
    assert.match(remaining.reply, /internet/iu);
    assert.match(remaining.reply, /bread/iu);
    assert.match(remaining.prompt, /state\/native\/todos\.json/u);
    assert.match(remaining.prompt, /state\/native\/shopping\.json/u);
    const beforeReflection = db.getDb().prepare('SELECT * FROM todos WHERE space_id = ? ORDER BY id').all(space.id);
    await say(
        'Why is it so difficult to book a plumber? They often do not answer, and agreeing on a time is difficult.'
    );
    assert.deepEqual(
        db.getDb().prepare('SELECT * FROM todos WHERE space_id = ? ORDER BY id').all(space.id),
        beforeReflection
    );
    assert.deepEqual(pending(), [['pay the internet bill'], ['bread']]);
    const final = await say('Remind me which tasks and shopping items still remain.');
    assert.match(final.reply, /internet/iu);
    assert.match(final.reply, /bread/iu);
    assert.doesNotMatch(final.reply, /plumb/iu);
    assert.deepEqual(pending(), [['pay the internet bill'], ['bread']]);
    console.log('PASS: persisted lists, completion, state-first context, and reflection isolation.');
    db.getDb().close();
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Live evaluation failed');
    process.exitCode = 1;
});
