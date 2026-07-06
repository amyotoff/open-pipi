import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireShoppingSpace(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_ERROR] Chat context missing.' };
    }

    return { ok: true, spaceId };
}

const skill: SkillManifest = {
    name: 'shopping',
    description: 'Shared shopping list management for groceries, household supplies, and simple buy-later items',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'office', 'tutor'],
    },

    migrations: [
        `CREATE TABLE IF NOT EXISTS shopping_list (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            item TEXT NOT NULL,
            quantity TEXT DEFAULT '1',
            added_by TEXT,
            added_at TEXT,
            purchased INTEGER DEFAULT 0,
            purchased_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_shopping_list_space_purchased_added
            ON shopping_list(space_id, purchased, added_at)`,
        `ALTER TABLE shopping_list ADD COLUMN space_id TEXT`,
    ],

    tools: [
        {
            name: 'shopping_add',
            description:
                'Add an item to the shopping list. Use this for "buy X" and "don’t forget to buy X" requests instead of creating a reminder.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    item: { type: Type.STRING, description: 'What needs to be bought.' },
                    quantity: {
                        type: Type.STRING,
                        description: 'Optional quantity or pack size, for example "2", "500g", or "1 bottle".',
                    },
                },
                required: ['item'],
            },
        },
        {
            name: 'shopping_list',
            description: 'Show pending shopping items for the current space.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'shopping_complete',
            description: 'Mark a shopping item as bought.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    item_id: { type: Type.INTEGER, description: 'Shopping item ID from the list.' },
                },
                required: ['item_id'],
            },
        },
        {
            name: 'shopping_remove',
            description: 'Remove a shopping item from the list entirely.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    item_id: { type: Type.INTEGER, description: 'Shopping item ID from the list.' },
                },
                required: ['item_id'],
            },
        },
    ],
    handlers: {
        async shopping_add(args: { item: string; quantity?: string }, context?: ExecutionContext) {
            const access = requireShoppingSpace(context);
            if (!access.ok) return access.message;

            const item = args.item.trim();
            if (!item) return '[TOOL_RESULT] shopping_add requires item.';

            const quantity = args.quantity?.trim() || '1';
            const db = getDb();
            const now = new Date().toISOString();
            db.prepare(
                `
                INSERT INTO shopping_list (space_id, item, quantity, added_by, added_at, purchased)
                VALUES (?, ?, ?, ?, ?, 0)
            `
            ).run(access.spaceId, item, quantity, context?.userId || null, now);

            const quantityNote = quantity !== '1' ? ` (${quantity})` : '';
            return `[TOOL_RESULT] Added to the shopping list: "${item}"${quantityNote}`;
        },

        async shopping_list(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireShoppingSpace(context);
            if (!access.ok) return access.message;

            const db = getDb();
            const items = db
                .prepare(
                    `
                    SELECT id, item, quantity, added_at
                    FROM shopping_list
                    WHERE space_id = ? AND purchased = 0
                    ORDER BY added_at, id
                `
                )
                .all(access.spaceId) as Array<{ id: number; item: string; quantity: string }>;

            if (items.length === 0) return '[TOOL_RESULT] The shopping list is empty.';

            return (
                '[TOOL_RESULT] Shopping list:\n' +
                items
                    .map(
                        (item) =>
                            `${item.id}. ${item.item}${item.quantity && item.quantity !== '1' ? ` (${item.quantity})` : ''}`
                    )
                    .join('\n')
            );
        },

        async shopping_complete(args: { item_id: number }, context?: ExecutionContext) {
            const access = requireShoppingSpace(context);
            if (!access.ok) return access.message;

            const db = getDb();
            const result = db
                .prepare(
                    `
                    UPDATE shopping_list
                    SET purchased = 1, purchased_at = ?
                    WHERE id = ? AND space_id = ? AND purchased = 0
                `
                )
                .run(new Date().toISOString(), args.item_id, access.spaceId);

            return result.changes > 0
                ? `[TOOL_RESULT] Marked shopping item #${args.item_id} as bought.`
                : `[TOOL_RESULT] Shopping item ID ${args.item_id} was not found in this chat.`;
        },

        async shopping_remove(args: { item_id: number }, context?: ExecutionContext) {
            const access = requireShoppingSpace(context);
            if (!access.ok) return access.message;

            const db = getDb();
            const result = db
                .prepare('DELETE FROM shopping_list WHERE id = ? AND space_id = ?')
                .run(args.item_id, access.spaceId);

            return result.changes > 0
                ? `[TOOL_RESULT] Removed shopping item #${args.item_id}.`
                : `[TOOL_RESULT] Shopping item ID ${args.item_id} was not found in this chat.`;
        },
    },
};

export default skill;
