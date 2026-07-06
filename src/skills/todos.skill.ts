import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireTodoSpace(context?: ExecutionContext): { ok: true; spaceId: string } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_ERROR] Chat context missing.' };
    }

    return { ok: true, spaceId };
}

const skill: SkillManifest = {
    name: 'todos',
    description: 'One-off task management for errands, admin, repairs, follow-ups, and discrete actions',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office'],
    },

    migrations: [
        `CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            added_at TEXT,
            completed_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_todos_space_status_added ON todos(space_id, status, added_at)`,
        `ALTER TABLE todos ADD COLUMN space_id TEXT`,
    ],

    tools: [
        {
            name: 'todos_add',
            description:
                'Add a one-off task to the ToDo list. Use this for discrete actions, not for recurring schedules.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task: {
                        type: Type.STRING,
                        description: 'Task description, e.g. "call the clinic", "fix the hinge", "send the invoice".',
                    },
                },
                required: ['task'],
            },
        },
        {
            name: 'todos_list',
            description: 'Show all pending one-off tasks.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'todos_complete',
            description: 'Mark a ToDo task as completed.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.INTEGER, description: 'ID of the task from the list.' },
                },
                required: ['task_id'],
            },
        },
        {
            name: 'todos_remove',
            description: 'Remove a task from the list entirely.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.INTEGER, description: 'ID of the task.' },
                },
                required: ['task_id'],
            },
        },
    ],
    handlers: {
        async todos_add(args: { task: string }, context?: ExecutionContext) {
            const access = requireTodoSpace(context);
            if (!access.ok) return access.message;
            const db = getDb();
            const now = new Date().toISOString();
            db.prepare('INSERT INTO todos (space_id, task, added_at) VALUES (?, ?, ?)').run(
                access.spaceId,
                args.task,
                now
            );
            return `[TOOL_RESULT] Added to the task list: "${args.task}"`;
        },
        async todos_list(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireTodoSpace(context);
            if (!access.ok) return access.message;
            const db = getDb();
            const items = db
                .prepare(
                    "SELECT id, task, added_at FROM todos WHERE space_id = ? AND status = 'pending' ORDER BY added_at"
                )
                .all(access.spaceId) as any[];
            if (items.length === 0) return '[TOOL_RESULT] The task list is empty.';
            return '[TOOL_RESULT] Task list:\n' + items.map((i: any) => `${i.id}. ${i.task}`).join('\n');
        },
        async todos_complete(args: { task_id: number }, context?: ExecutionContext) {
            const access = requireTodoSpace(context);
            if (!access.ok) return access.message;
            const db = getDb();
            const result = db
                .prepare("UPDATE todos SET status = 'completed', completed_at = ? WHERE id = ? AND space_id = ?")
                .run(new Date().toISOString(), args.task_id, access.spaceId);
            return result.changes > 0
                ? `[TOOL_RESULT] Completed task #${args.task_id}.`
                : `[TOOL_RESULT] Task ID ${args.task_id} was not found in this chat.`;
        },
        async todos_remove(args: { task_id: number }, context?: ExecutionContext) {
            const access = requireTodoSpace(context);
            if (!access.ok) return access.message;
            const db = getDb();
            const result = db
                .prepare('DELETE FROM todos WHERE id = ? AND space_id = ?')
                .run(args.task_id, access.spaceId);
            return result.changes > 0
                ? `[TOOL_RESULT] Removed task #${args.task_id} from the list.`
                : `[TOOL_RESULT] Task ID ${args.task_id} was not found in this chat.`;
        },
    },
};

export default skill;
