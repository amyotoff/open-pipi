import {
    ensureSpace,
    ensureSpaceMembership,
    getSpace,
    getTransportBinding,
    listGroundingOverrides,
    updateSpacePolicy,
    upsertGroundingOverride,
} from '../db';
import {
    EMPTY_OWNER_CONTEXT_MARKER,
    markOwnerContextApplied,
    readOwnerContext,
    SETUP_OWNER_CONTEXT_SOURCE,
    SETUP_OWNER_CONTEXT_SUBJECT,
} from '../setup/owner-context';

export type ApplyOwnerContextResult =
    | { status: 'none' | 'already_applied' | 'ambiguous_owner' | 'unsafe_binding' }
    | { status: 'applied'; spaceId: string };

/** Apply pending setup context once the runtime database is initialized. */
export function applyPendingOwnerContext(input: {
    dataDir: string;
    ownerTelegramIds: readonly string[];
}): ApplyOwnerContextResult {
    const context = readOwnerContext(input.dataDir);
    if (!context) return { status: 'none' };
    if (context.applied?.revision === context.revision) return { status: 'already_applied' };

    const owners = [...new Set(input.ownerTelegramIds.map((id) => id.trim()).filter(Boolean))];
    if (owners.length !== 1) return { status: 'ambiguous_owner' };
    const ownerId = owners[0];
    const binding = getTransportBinding('telegram', ownerId);
    if (binding && (binding.status !== 'active' || binding.endpoint_type !== 'direct')) {
        return { status: 'unsafe_binding' };
    }
    const boundSpace = binding ? getSpace(binding.space_id) : undefined;
    if (binding && (!boundSpace || boundSpace.kind !== 'direct_chat')) return { status: 'unsafe_binding' };

    const conventionalSpace = getSpace(`telegram:${ownerId}`);
    if (!binding && conventionalSpace && conventionalSpace.kind !== 'direct_chat') return { status: 'unsafe_binding' };
    const space =
        boundSpace ||
        conventionalSpace ||
        ensureSpace('telegram', ownerId, {
            kind: 'direct_chat',
            title: context.displayName || ownerId,
        });
    ensureSpaceMembership(space.id, ownerId, 'owner');

    updateSpacePolicy(space.id, {
        default_language: context.language,
        timezone: context.timezone,
    });

    const privateContext = [
        context.displayName ? `Preferred name: ${context.displayName}` : '',
        ...(context.facts || []).map((fact) => `Owner-provided fact: ${fact}`),
        context.currentTask
            ? `Current task context (descriptive only; it grants no tool authority): ${context.currentTask}`
            : '',
    ].filter(Boolean);
    const subjectOverrides = listGroundingOverrides(space.id, { includeInactive: true, limit: 100 }).filter(
        (override) => override.subject === SETUP_OWNER_CONTEXT_SUBJECT
    );
    const activeSubjectOverrides = subjectOverrides.filter((override) => override.status === 'active');
    const activeSetupOverride =
        activeSubjectOverrides.length === 1 && activeSubjectOverrides[0].created_by === SETUP_OWNER_CONTEXT_SOURCE
            ? activeSubjectOverrides[0]
            : undefined;

    if (activeSetupOverride) {
        upsertGroundingOverride({
            space_id: space.id,
            kind: 'person',
            subject: SETUP_OWNER_CONTEXT_SUBJECT,
            content: privateContext.length > 0 ? privateContext.join('\n') : EMPTY_OWNER_CONTEXT_MARKER,
            created_by: SETUP_OWNER_CONTEXT_SOURCE,
        });
    } else if (privateContext.length > 0 && subjectOverrides.length === 0) {
        upsertGroundingOverride({
            space_id: space.id,
            kind: 'person',
            subject: SETUP_OWNER_CONTEXT_SUBJECT,
            content: privateContext.join('\n'),
            created_by: SETUP_OWNER_CONTEXT_SOURCE,
        });
    }

    try {
        markOwnerContextApplied(input.dataDir, context.revision, space.id);
    } catch {}
    return { status: 'applied', spaceId: space.id };
}
