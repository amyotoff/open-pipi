import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BrainScopeInput, brainPath, nowIso } from './brain-store';

export type StateKind = 'apartment' | 'project' | 'todo' | 'shopping' | 'object';
export type StateStatus = 'known' | 'unknown' | 'stale' | 'unavailable' | 'disputed';
export type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };
export interface StateField {
    value: StateValue;
    value_type?: 'boolean' | 'number' | 'string' | 'array' | 'object';
    status: StateStatus;
    observed_at: string | null;
    source: string | null;
    unit?: string | null;
    refresh?: { provider: string; entity_id: string } | null;
    max_age_seconds?: number | null;
}
export interface StateItem {
    id: string;
    text: string;
    status: 'pending' | 'done';
    quantity?: string;
}
export interface StateDocument {
    schema_version: 1;
    id: string;
    kind: StateKind;
    title: string;
    aliases: string[];
    revision: number;
    updated_at: string;
    fields: Record<string, StateField>;
    items: StateItem[];
    last_change: { actor: string; source: string };
}
export interface StatePatch {
    kind?: StateKind;
    title?: string;
    aliases?: string[];
    set_fields?: Record<string, StateField>;
    remove_fields?: string[];
    upsert_items?: StateItem[];
    remove_items?: string[];
}

export const MAX_STATE_BYTES = 64 * 1024;
const KINDS = ['apartment', 'project', 'todo', 'shopping', 'object'];
const STATUSES = ['known', 'unknown', 'stale', 'unavailable', 'disputed'];
const RESERVED_IDS = new Set(['todos', 'shopping']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never {
    throw new Error(`Invalid structured state: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
    const extra = Object.keys(value).find((key) => !allowed.includes(key));
    if (extra) fail(`${label} has unsupported key ${extra}.`);
}

function text(value: unknown, label: string, max = 512): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} needs 1–${max} characters.`);
}

export function validateStateId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || UNSAFE_KEYS.has(value)) {
        fail('id must contain 1–64 lowercase letters, digits, hyphens or underscores.');
    }
}

function fieldKey(value: string): void {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,95}$/u.test(value) || UNSAFE_KEYS.has(value)) fail('Unsafe field key.');
}

function timestamp(value: unknown, label: string): void {
    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
    )
        fail(`${label} must be a valid UTC ISO timestamp.`);
}

function jsonValue(value: unknown, depth = 0): void {
    if (depth > 10) fail('JSON nesting exceeds 10 levels.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
        value.forEach((item) => jsonValue(item, depth + 1));
        return;
    }
    const record = object(value, 'JSON value');
    for (const [key, child] of Object.entries(record)) {
        if (UNSAFE_KEYS.has(key)) fail('Unsafe JSON property.');
        jsonValue(child, depth + 1);
    }
}

function parseJson(input: string): unknown {
    if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_STATE_BYTES) fail('JSON exceeds 64 KiB.');
    let value: unknown;
    try {
        value = JSON.parse(input);
    } catch {
        fail('Malformed JSON.');
    }
    jsonValue(value);
    return value;
}

function validateField(value: unknown): void {
    const field = object(value, 'field');
    keys(
        field,
        ['value', 'value_type', 'status', 'observed_at', 'source', 'unit', 'refresh', 'max_age_seconds'],
        'field'
    );
    if (!Object.hasOwn(field, 'value')) fail('field.value is required.');
    jsonValue(field.value);
    if (field.value_type !== undefined) {
        if (!['boolean', 'number', 'string', 'array', 'object'].includes(field.value_type as string))
            fail('Unsupported value_type.');
        if (field.value !== null && valueType(field.value) !== field.value_type)
            fail('Value does not match value_type.');
    }
    if (!STATUSES.includes(field.status as string)) fail('Unknown field status.');
    if (field.observed_at !== null) timestamp(field.observed_at, 'observed_at');
    if (field.source !== null) text(field.source, 'source');
    if (field.status === 'known' && (field.value === null || !field.source || !field.observed_at)) {
        fail('known fields require a non-null value, source and observed_at.');
    }
    if (field.status === 'unknown' && field.value !== null) fail('unknown fields must have a null value.');
    if (field.unit !== undefined && field.unit !== null) text(field.unit, 'unit', 32);
    if (field.refresh !== undefined && field.refresh !== null) {
        const refresh = object(field.refresh, 'refresh');
        keys(refresh, ['provider', 'entity_id'], 'refresh');
        text(refresh.provider, 'provider', 64);
        text(refresh.entity_id, 'entity_id', 160);
    }
    if (
        field.max_age_seconds !== undefined &&
        field.max_age_seconds !== null &&
        (!Number.isSafeInteger(field.max_age_seconds) || (field.max_age_seconds as number) < 0)
    ) {
        fail('max_age_seconds must be a nonnegative integer or null.');
    }
}

function valueType(value: unknown): StateField['value_type'] {
    if (value === null) return undefined;
    return (Array.isArray(value) ? 'array' : typeof value) as StateField['value_type'];
}

function validateItem(value: unknown): void {
    const item = object(value, 'item');
    keys(item, ['id', 'text', 'status', 'quantity'], 'item');
    validateStateId(item.id);
    text(item.text, 'item.text', 1000);
    if (!['pending', 'done'].includes(item.status as string)) fail('Item status must be pending or done.');
    if (item.quantity !== undefined) text(item.quantity, 'quantity', 80);
}

function aliases(value: unknown): void {
    if (!Array.isArray(value) || value.length > 16) fail('aliases must be an array of at most 16 names.');
    value.forEach((alias) => text(alias, 'alias', 100));
}

export function validateStateDocument(input: unknown): StateDocument {
    const doc = object(input, 'document');
    keys(
        doc,
        [
            'schema_version',
            'id',
            'kind',
            'title',
            'aliases',
            'revision',
            'updated_at',
            'fields',
            'items',
            'last_change',
        ],
        'document'
    );
    jsonValue(doc);
    if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_STATE_BYTES) fail('Document exceeds 64 KiB.');
    if (doc.schema_version !== 1) fail('Unsupported schema_version.');
    validateStateId(doc.id);
    if (!KINDS.includes(doc.kind as string)) fail('Unsupported state kind; reflections belong in wiki articles.');
    text(doc.title, 'title', 160);
    aliases(doc.aliases);
    if (!Number.isSafeInteger(doc.revision) || (doc.revision as number) < 1)
        fail('revision must be a positive integer.');
    timestamp(doc.updated_at, 'updated_at');
    const fields = object(doc.fields, 'fields');
    if (Object.keys(fields).length > 128) fail('At most 128 fields are allowed.');
    for (const [key, field] of Object.entries(fields)) {
        fieldKey(key);
        validateField(field);
    }
    if (!Array.isArray(doc.items) || doc.items.length > 200) fail('items must be an array of at most 200 entries.');
    doc.items.forEach(validateItem);
    if (new Set(doc.items.map((item) => item.id)).size !== doc.items.length) fail('Duplicate item id.');
    if (!['todo', 'shopping'].includes(doc.kind as string) && doc.items.length)
        fail('Only todo/shopping states have items.');
    if (doc.kind !== 'shopping' && doc.items.some((item) => item.quantity !== undefined))
        fail('quantity is for shopping items.');
    const change = object(doc.last_change, 'last_change');
    keys(change, ['actor', 'source'], 'last_change');
    text(change.actor, 'actor');
    text(change.source, 'change source');
    return doc as unknown as StateDocument;
}

export function parseStatePatch(input: string): StatePatch {
    const patch = object(parseJson(input), 'patch');
    keys(patch, ['kind', 'title', 'aliases', 'set_fields', 'remove_fields', 'upsert_items', 'remove_items'], 'patch');
    if (!Object.keys(patch).length) fail('Empty patch.');
    if (patch.kind !== undefined && !KINDS.includes(patch.kind as string)) fail('Unsupported state kind.');
    if (patch.title !== undefined) text(patch.title, 'title', 160);
    if (patch.aliases !== undefined) aliases(patch.aliases);
    if (patch.set_fields !== undefined) {
        for (const [key, field] of Object.entries(object(patch.set_fields, 'set_fields'))) {
            fieldKey(key);
            validateField(field);
        }
    }
    for (const key of ['remove_fields', 'remove_items']) {
        if (patch[key] === undefined) continue;
        if (!Array.isArray(patch[key]) || patch[key].length > 200) fail(`${key} must be a bounded array.`);
        (patch[key] as unknown[]).forEach((id) => {
            if (typeof id !== 'string') fail(`${key} entries must be strings.`);
            if (key === 'remove_items') validateStateId(id);
            else fieldKey(id);
        });
        if (new Set(patch[key] as string[]).size !== (patch[key] as string[]).length) fail(`Duplicate ${key}.`);
    }
    if (patch.upsert_items !== undefined) {
        if (!Array.isArray(patch.upsert_items) || patch.upsert_items.length > 200)
            fail('upsert_items must be a bounded array.');
        patch.upsert_items.forEach(validateItem);
        if (new Set(patch.upsert_items.map((item) => item.id)).size !== patch.upsert_items.length)
            fail('Duplicate item id.');
    }
    const typed = patch as StatePatch;
    if (
        typed.remove_fields?.some((key) => Object.hasOwn(typed.set_fields || {}, key)) ||
        typed.remove_items?.some((id) => typed.upsert_items?.some((item) => item.id === id))
    )
        fail('Cannot set and remove the same entry.');
    return typed;
}

function statePath(scope: BrainScopeInput, id: string): string {
    validateStateId(id);
    if (!scope.shared && !scope.spaceId) throw new Error('Structured state requires a space or explicit shared scope.');
    const directory = brainPath(scope, 'state');
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
        throw new Error('State directory cannot be a symlink.');
    const file = path.join(directory, `${id}.json`);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('State file cannot be a symlink.');
    return file;
}

export function readStoredState(scope: BrainScopeInput, id: string): StateDocument | null {
    const file = statePath(scope, id);
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > MAX_STATE_BYTES) fail('Stored document exceeds 64 KiB.');
    const doc = validateStateDocument(parseJson(fs.readFileSync(file, 'utf8')));
    if (doc.id !== id) fail('File id does not match document id.');
    return doc;
}

export function listStoredStates(scope: BrainScopeInput): { documents: StateDocument[]; errors: string[] } {
    const directory = path.dirname(statePath(scope, 'catalog'));
    if (!fs.existsSync(directory)) return { documents: [], errors: [] };
    const documents: StateDocument[] = [];
    const errors: string[] = [];
    for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        try {
            const doc = readStoredState(scope, id);
            if (doc) documents.push(doc);
        } catch {
            errors.push(`Cannot read state ${id}; inspect or repair its JSON.`);
        }
    }
    return { documents, errors };
}

/** Atomic file replacement plus revision checking under a cross-process exclusive writer lock. */
export function updateStoredState(
    input: {
        id: string;
        expected_revision: number;
        patch_json: string;
        actor: string;
        source: string;
        now?: Date;
    } & BrainScopeInput
): StateDocument {
    const file = statePath(input, input.id);
    if (RESERVED_IDS.has(input.id)) throw new Error('Use todos_* or shopping_* for the built-in lists.');
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)
        fail('expected_revision must be a nonnegative integer.');
    const patch = parseStatePatch(input.patch_json);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    let lockFd: number;
    try {
        lockFd = fs.openSync(lock, 'wx', 0o600);
    } catch {
        throw new Error(
            'State is locked by another writer; read it again before retrying. A stale lock requires operator inspection.'
        );
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        const current = readStoredState(input, input.id);
        if ((current?.revision || 0) !== input.expected_revision)
            throw new Error(
                `State revision conflict: expected ${input.expected_revision}, current ${current?.revision || 0}. Read before retrying.`
            );
        if (!current && (!patch.kind || !patch.title)) fail('Creating state requires kind and title.');
        if (current && patch.kind && patch.kind !== current.kind) fail('State kind cannot change.');
        const now = nowIso(input.now);
        const doc: StateDocument = current
            ? structuredClone(current)
            : {
                  schema_version: 1,
                  id: input.id,
                  kind: patch.kind!,
                  title: patch.title!,
                  aliases: [],
                  revision: 0,
                  updated_at: now,
                  fields: {},
                  items: [],
                  last_change: { actor: input.actor, source: input.source },
              };
        if (patch.title !== undefined) doc.title = patch.title;
        if (patch.aliases !== undefined) doc.aliases = patch.aliases;
        for (const [key, field] of Object.entries(patch.set_fields || {})) {
            const previous = doc.fields[key];
            const expectedType = previous?.value_type || valueType(previous?.value ?? null);
            if (
                expectedType &&
                ((field.value_type && field.value_type !== expectedType) ||
                    (field.value !== null && valueType(field.value) !== expectedType))
            )
                fail(`Field ${key} must retain type ${expectedType}.`);
            if (field.observed_at && Date.parse(field.observed_at) > Date.parse(now) + 300_000)
                fail('Observation time is in the future.');
            if (
                previous?.observed_at &&
                field.observed_at &&
                Date.parse(field.observed_at) < Date.parse(previous.observed_at)
            )
                fail(`Older observation for ${key}.`);
            if (
                previous?.status === 'known' &&
                field.status === 'known' &&
                previous.observed_at === field.observed_at &&
                (JSON.stringify(previous.value) !== JSON.stringify(field.value) ||
                    (field.unit !== undefined && previous.unit !== field.unit))
            )
                fail(`Conflicting observation for ${key}; use disputed status.`);
            // Value/time/source are required; omitted optional type and freshness metadata survive a value update.
            doc.fields[key] = {
                ...previous,
                ...field,
                value_type: expectedType || field.value_type || valueType(field.value),
            };
            if (doc.fields[key].value_type === undefined) delete doc.fields[key].value_type;
        }
        for (const key of patch.remove_fields || []) {
            if (!Object.hasOwn(doc.fields, key)) fail(`Field ${key} does not exist.`);
            delete doc.fields[key];
        }
        for (const item of patch.upsert_items || []) {
            const index = doc.items.findIndex((existing) => existing.id === item.id);
            if (index < 0) doc.items.push(item);
            else doc.items[index] = item;
        }
        for (const id of patch.remove_items || []) {
            if (!doc.items.some((item) => item.id === id)) fail(`Item ${id} does not exist.`);
            doc.items = doc.items.filter((item) => item.id !== id);
        }
        doc.revision += 1;
        doc.updated_at = now;
        doc.last_change = { actor: input.actor, source: input.source };
        validateStateDocument(doc);
        const fd = fs.openSync(temp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(doc));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, file);
        return doc;
    } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}

/** Freshness is computed on read; an old file is never silently relabelled as fresh. */
export function fieldFreshness(field: StateField, now = new Date()): StateStatus {
    if (field.status !== 'known') return field.status;
    if (!field.observed_at || Date.parse(field.observed_at) > now.getTime() + 300_000) return 'unknown';
    if (field.refresh && field.max_age_seconds == null) return 'stale';
    if (field.max_age_seconds != null && now.getTime() - Date.parse(field.observed_at) >= field.max_age_seconds * 1000)
        return 'stale';
    return 'known';
}
