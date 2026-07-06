import crypto from 'crypto';
import {
    archiveOldArtifactsForKind,
    Artifact,
    createArtifact,
    getActiveProjectForSpace,
    getLatestArtifactByKind,
    getSpace,
    listTimelineEvents,
} from '../db';
import { getMemoryContext } from './memory-context';
import { appendTimelineEvent, getLocalDayKey } from './timeline';
import { truncate } from './work-lenses';

function makeHandoffTitle(): string {
    return `Handoff ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`;
}

function shiftDayKey(day: string, offsetDays: number): string {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
}

function formatArtifactBullet(artifact: Artifact | undefined, fallbackLabel: string): string {
    if (!artifact) {
        return `- ${fallbackLabel}: none`;
    }

    return `- ${fallbackLabel}: ${artifact.title} — ${artifact.summary}`;
}

export function buildHandoffRef(spaceId: string): string {
    const space = getSpace(spaceId);
    const activeProject = getActiveProjectForSpace(spaceId);
    const plan = getLatestArtifactByKind(spaceId, 'plan');
    const taskList = getLatestArtifactByKind(spaceId, 'task_list');
    const review = getLatestArtifactByKind(spaceId, 'review');
    const today = getLocalDayKey();
    const fromDay = shiftDayKey(today, -2);
    const timeline = listTimelineEvents(spaceId, { fromDay, toDay: today, limit: 8 });
    const memory = getMemoryContext({
        spaceId,
        projectId: activeProject?.id,
    });

    const recommendedNextStep =
        activeProject?.next_step?.trim() ||
        plan?.summary?.trim() ||
        taskList?.summary?.trim() ||
        'Review the active artifacts and continue with the smallest useful next step.';

    const timelineLines =
        timeline.length > 0
            ? timeline
                  .slice()
                  .reverse()
                  .map((event) => `- ${event.day} ${event.happened_at.slice(11, 16)} • ${event.summary}`)
                  .join('\n')
            : '- No recent timeline events.';

    const memoryBlock = memory ? truncate(memory, 1400) : 'None.';

    return [
        '# Handoff',
        '',
        '## Space',
        `- Space: ${space?.title || spaceId}`,
        `- Channel: ${space?.channel || 'unknown'}`,
        `- Pack: ${space?.assistant_pack_id || 'unknown'}`,
        '',
        '## Current Focus',
        activeProject
            ? `- Project: ${activeProject.title} (${activeProject.state})\n- Goal: ${activeProject.goal || 'none'}\n- Next step: ${activeProject.next_step || 'none'}`
            : '- No active project.',
        '',
        '## Active Artifacts',
        formatArtifactBullet(plan, 'Plan'),
        formatArtifactBullet(taskList, 'Task list'),
        formatArtifactBullet(review, 'Latest review'),
        '',
        '## Recent Timeline',
        timelineLines,
        '',
        '## Memory Highlights',
        memoryBlock,
        '',
        '## Recommended Next Step',
        recommendedNextStep,
    ].join('\n');
}

export function createHandoffArtifactForSpace(spaceId: string): Artifact {
    const title = makeHandoffTitle();
    const ref = buildHandoffRef(spaceId);
    const artifactId = `art_${crypto.randomUUID()}`;
    const summary = truncate(ref.split(/\r?\n/).find((line) => line.startsWith('- Project:')) || 'Space handoff', 160);

    createArtifact({
        id: artifactId,
        space_id: spaceId,
        source_message_id: null,
        kind: 'handoff',
        title,
        ref,
        summary,
    });
    archiveOldArtifactsForKind(spaceId, 'handoff', artifactId);

    appendTimelineEvent({
        spaceId,
        type: 'handoff.generated',
        refType: 'artifact_db',
        refId: artifactId,
        summary: `Generated handoff artifact "${title}".`,
        details: {
            kind: 'handoff',
            title,
        },
    });

    return getLatestArtifactByKind(spaceId, 'handoff')!;
}

export function resumeFromHandoffForSpace(spaceId: string): Artifact {
    return getLatestArtifactByKind(spaceId, 'handoff') || createHandoffArtifactForSpace(spaceId);
}
