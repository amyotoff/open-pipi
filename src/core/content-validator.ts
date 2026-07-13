import fs from 'node:fs';
import path from 'node:path';
import { loadPackFromRootStrict } from './pack-loader';
import { loadGroundingPackFromRootStrict } from './grounding-loader';
import { validateReminderCron } from './reminder-schedule';
import { isSafeContentId } from './content-id';

export type ContentCheckStatus = 'pass' | 'fail';

export type ContentCheck = {
    kind: 'packs' | 'groundings' | 'pack' | 'grounding';
    id: string;
    status: ContentCheckStatus;
    message: string;
};

export type ContentRoots = {
    packs: string;
    groundings: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(value: unknown, label: string, errors: string[]): void {
    if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
        errors.push(`${label} must be an array of non-empty strings`);
        return;
    }
    if (new Set(value).size !== value.length) errors.push(`${label} contains duplicates`);
}

function listDirectories(root: string): string[] {
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
}

export function listSkillCapabilityIds(skillsRoot: string): Set<string> {
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) return new Set();

    return new Set(
        fs
            .readdirSync(skillsRoot)
            .filter((file) => file.endsWith('.skill.ts') || file.endsWith('.skill.js'))
            .map((file) => file.replace(/\.skill\.(ts|js)$/i, '').replace(/-/g, '_'))
    );
}

export function validatePackRoot(
    root: string,
    directoryId = path.basename(root),
    knownCapabilities?: ReadonlySet<string>
): ContentCheck {
    try {
        const pack = loadPackFromRootStrict(root);
        const errors: string[] = [];

        if (!isSafeContentId(directoryId)) errors.push('directory name is not a safe pack ID');
        if (!isNonEmptyString(pack.id)) errors.push('agent id is required');
        else if (pack.id !== directoryId) errors.push(`agent id "${pack.id}" must match directory "${directoryId}"`);
        if (!isNonEmptyString(pack.persona_id)) errors.push('persona_id is required');
        if (!isNonEmptyString(pack.system_prompt)) errors.push('agent prompt body is required');
        validateStringArray(pack.enabled_capabilities, 'enabled_capabilities', errors);
        if (knownCapabilities) {
            const unknownCapabilities = pack.enabled_capabilities.filter((name) => !knownCapabilities.has(name));
            if (unknownCapabilities.length > 0) {
                errors.push(`unknown enabled capabilities: ${unknownCapabilities.join(', ')}`);
            }
        }
        validateStringArray(pack.memory_rules, 'memory_rules', errors);
        if (!isRecord(pack.default_policies)) errors.push('default_policies must be an object');
        if (!isRecord(pack.authority_presets)) errors.push('authority_presets must be an object');

        if (pack.family_members) {
            const memberIds = new Set<string>();
            for (const [index, member] of pack.family_members.entries()) {
                const label = `family_members[${index}]`;
                if (!isNonEmptyString(member.id)) errors.push(`${label}.id is required`);
                else if (memberIds.has(member.id)) errors.push(`duplicate family member "${member.id}"`);
                else memberIds.add(member.id);
                if (!isNonEmptyString(member.role)) errors.push(`${label}.role is required`);
                if (!isNonEmptyString(member.character)) errors.push(`${label}.character is required`);
                validateStringArray(member.instructions, `${label}.instructions`, errors);
            }
        }

        if (!Array.isArray(pack.seeded_tasks)) {
            errors.push('seeded_tasks must be an array');
        } else {
            const templateIds = new Set<string>();
            for (const [index, task] of pack.seeded_tasks.entries()) {
                const label = `seeded_tasks[${index}]`;
                if (!isNonEmptyString(task.template_id)) errors.push(`${label}.template_id is required`);
                else if (templateIds.has(task.template_id)) errors.push(`duplicate seeded task "${task.template_id}"`);
                else templateIds.add(task.template_id);
                if (!isNonEmptyString(task.title)) errors.push(`${label}.title is required`);
                if (!['assistant_prompt', 'atelier_summary'].includes(task.kind))
                    errors.push(`${label}.kind is invalid`);
                if (!isNonEmptyString(task.schedule_value) || !validateReminderCron(task.schedule_value)) {
                    errors.push(`${label}.schedule_value is not a valid cron expression`);
                }
                if (!isNonEmptyString(task.prompt)) errors.push(`${label}.prompt is required`);
            }
        }

        const toolIds = pack.pack_tools.map((tool) => tool.id);
        if (new Set(toolIds).size !== toolIds.length) errors.push('pack tool IDs must be unique');

        return errors.length > 0
            ? { kind: 'pack', id: directoryId, status: 'fail', message: errors.join('; ') }
            : {
                  kind: 'pack',
                  id: directoryId,
                  status: 'pass',
                  message: `${pack.enabled_capabilities.length} capabilities, ${pack.seeded_tasks.length} seeded tasks, ${pack.pack_tools.length} pack tools`,
              };
    } catch (error) {
        return {
            kind: 'pack',
            id: directoryId,
            status: 'fail',
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

function isValidTimeZone(value: string): boolean {
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}

export function validateGroundingRoot(root: string, directoryId = path.basename(root)): ContentCheck {
    try {
        const grounding = loadGroundingPackFromRootStrict(root);
        const errors: string[] = [];

        if (!isSafeContentId(directoryId)) errors.push('directory name is not a safe grounding ID');
        if (!isNonEmptyString(grounding.id)) errors.push('grounding id is required');
        else if (grounding.id !== directoryId) {
            errors.push(`grounding id "${grounding.id}" must match directory "${directoryId}"`);
        }
        if (!isNonEmptyString(grounding.title)) errors.push('title is required');
        if (!isNonEmptyString(grounding.grounding_text)) errors.push('grounding body is required');
        if (!isNonEmptyString(grounding.operating_text)) errors.push('operating.md must not be empty');
        validateStringArray(grounding.memory_focus, 'memory_focus', errors);
        validateStringArray(grounding.attention_bias, 'attention_bias', errors);
        if (grounding.timezone && !isValidTimeZone(grounding.timezone)) {
            errors.push(`timezone "${grounding.timezone}" is invalid`);
        }

        return errors.length > 0
            ? { kind: 'grounding', id: directoryId, status: 'fail', message: errors.join('; ') }
            : {
                  kind: 'grounding',
                  id: directoryId,
                  status: 'pass',
                  message: `${grounding.memory_focus.length} memory focus areas, ${grounding.attention_bias.length} attention biases`,
              };
    } catch (error) {
        return {
            kind: 'grounding',
            id: directoryId,
            status: 'fail',
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

export function validateContentRoots(roots: ContentRoots, knownCapabilities?: ReadonlySet<string>): ContentCheck[] {
    const checks: ContentCheck[] = [];

    const rootEntries: Array<['packs' | 'groundings', string]> = [
        ['packs', roots.packs],
        ['groundings', roots.groundings],
    ];
    for (const [kind, root] of rootEntries) {
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            checks.push({ kind, id: kind, status: 'fail', message: `${root} is missing or is not a directory` });
            continue;
        }
        const ids = listDirectories(root);
        if (ids.length === 0) {
            checks.push({ kind, id: kind, status: 'fail', message: `${root} contains no installable content` });
            continue;
        }
        for (const id of ids) {
            checks.push(
                kind === 'packs'
                    ? validatePackRoot(path.join(root, id), id, knownCapabilities)
                    : validateGroundingRoot(path.join(root, id), id)
            );
        }
    }

    return checks;
}

export function formatContentCheckReport(checks: readonly ContentCheck[]): string {
    const lines = ['Open PiPi content check', ''];
    for (const item of checks) {
        lines.push(`[${item.status === 'pass' ? 'PASS' : 'FAIL'}] ${item.kind}/${item.id}: ${item.message}`);
    }
    const failures = checks.filter((item) => item.status === 'fail').length;
    lines.push(
        '',
        failures === 0 ? `Content is valid (${checks.length} items).` : `Content is invalid (${failures} failures).`
    );
    return lines.join('\n');
}
