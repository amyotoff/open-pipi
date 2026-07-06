import { rememberMemoryEntry } from '../db';
import { invalidateMemoryContextCache } from './memory-context';
import { ensureActiveMemorySprint } from './memory-sprint';

type MemoryWriteOptions = {
    salience?: number;
    source?: string;
    /** When set, the entry is only surfaced in the given space context. */
    spaceBoundId?: string;
};

function writeStructuredMemory(
    scopeType: 'person' | 'space' | 'work' | 'project',
    scopeId: string,
    kind: string,
    content: string,
    options?: MemoryWriteOptions
): void {
    const sprintId = scopeType === 'person' || scopeType === 'project' ? null : ensureActiveMemorySprint(scopeId).id;

    rememberMemoryEntry({
        scope_type: scopeType,
        scope_id: scopeId,
        memory_sprint_id: sprintId,
        kind,
        content,
        salience: options?.salience,
        source: options?.source,
        space_bound_id: options?.spaceBoundId,
    });
    invalidateMemoryContextCache();
}

export function rememberPersonMemory(
    personId: string,
    kind: string,
    content: string,
    options?: MemoryWriteOptions
): void {
    writeStructuredMemory('person', personId, kind, content, options);
}

export function rememberSpaceMemory(
    spaceId: string,
    kind: string,
    content: string,
    options?: MemoryWriteOptions
): void {
    writeStructuredMemory('space', spaceId, kind, content, options);
}

export function rememberWorkMemory(spaceId: string, kind: string, content: string, options?: MemoryWriteOptions): void {
    writeStructuredMemory('work', spaceId, kind, content, options);
}

export function rememberProjectMemory(
    projectId: string,
    kind: string,
    content: string,
    options?: MemoryWriteOptions
): void {
    writeStructuredMemory('project', projectId, kind, content, options);
}

export function rememberWorkflowArtifact(
    spaceId: string,
    templateId: string,
    title: string,
    relativePath: string,
    packId: string
): void {
    rememberWorkMemory(
        spaceId,
        'workflow_artifact',
        `Saved ${templateId} for pack "${packId}": ${title} -> ${relativePath}`,
        { salience: 0.55, source: 'workflow_save' }
    );
}

export function rememberTaskOutcome(
    spaceId: string,
    taskTitle: string,
    status: 'success' | 'failed',
    summary: string
): void {
    rememberWorkMemory(
        spaceId,
        status === 'success' ? 'task_outcome' : 'task_failure',
        `Task "${taskTitle}" ${status === 'success' ? 'completed' : 'failed'}: ${summary}`,
        { salience: status === 'success' ? 0.45 : 0.7, source: 'task_run' }
    );
}
