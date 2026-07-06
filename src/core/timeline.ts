import crypto from 'crypto';
import {
    createArtifact,
    createTimelineEvent,
    getArtifactByKindAndTitle,
    getSpace,
    listTimelineEvents,
    TimelineEvent,
    updateArtifact,
} from '../db';

type TimelineEventInput = {
    spaceId: string;
    type: string;
    summary: string;
    refType?: string;
    refId?: string;
    details?: Record<string, unknown>;
    happenedAt?: string;
};

type JournalRange = 'today' | 'yesterday' | 'week';

const DEFAULT_TIMEZONE = process.env.TZ || 'UTC';

function formatWithParts(value: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
    return Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TIMEZONE, ...options })
            .formatToParts(value)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );
}

export function getLocalDayKey(input: Date | string = new Date()): string {
    const value = typeof input === 'string' ? new Date(input) : input;
    const parts = formatWithParts(value, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDayKey(day: string, offsetDays: number): string {
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + offsetDays);
    return next.toISOString().substring(0, 10);
}

function formatDayHeading(day: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: DEFAULT_TIMEZONE,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(new Date(`${day}T12:00:00Z`));
}

function formatTimeLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: DEFAULT_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(iso));
}

function formatTimelineLine(event: TimelineEvent): string {
    return `- ${formatTimeLabel(event.happened_at)} • ${event.type} • ${event.summary}`;
}

function buildJournalTitle(day: string): string {
    return `Journal ${day}`;
}

function buildJournalRef(spaceId: string, day: string, events: TimelineEvent[]): string {
    const spaceLabel = getSpace(spaceId)?.title || spaceId;
    const lines =
        events.length > 0
            ? events
                  .slice()
                  .sort((left, right) => left.happened_at.localeCompare(right.happened_at))
                  .map(formatTimelineLine)
            : ['- No timeline events were recorded.'];

    return [
        `Derived daily journal for ${day}.`,
        'Source of truth: timeline events.',
        '',
        `## Space`,
        spaceLabel,
        '',
        `## Day`,
        `${day} (${formatDayHeading(day)})`,
        '',
        '## Timeline',
        ...lines,
    ].join('\n');
}

export function syncJournalDayArtifact(spaceId: string, day: string): void {
    const title = buildJournalTitle(day);
    const events = listTimelineEvents(spaceId, { day, limit: 250 });
    const summary = `Derived daily journal for ${day} with ${events.length} timeline event(s).`;
    const ref = buildJournalRef(spaceId, day, events);
    const existing = getArtifactByKindAndTitle(spaceId, 'journal_day', title);

    if (existing) {
        updateArtifact(existing.id, {
            title,
            summary,
            ref,
            archived_at: null,
        });
        return;
    }

    createArtifact({
        id: `art_${crypto.randomUUID()}`,
        space_id: spaceId,
        source_message_id: null,
        kind: 'journal_day',
        title,
        summary,
        ref,
    });
}

export function appendTimelineEvent(input: TimelineEventInput): TimelineEvent {
    const happenedAt = input.happenedAt || new Date().toISOString();
    const event = createTimelineEvent({
        id: `tl_${crypto.randomUUID()}`,
        space_id: input.spaceId,
        day: getLocalDayKey(happenedAt),
        happened_at: happenedAt,
        type: input.type,
        ref_type: input.refType || null,
        ref_id: input.refId || null,
        summary: input.summary.trim(),
        details_json: JSON.stringify(input.details || {}),
        created_at: new Date().toISOString(),
    });

    syncJournalDayArtifact(input.spaceId, event.day);
    return event;
}

function renderSingleDay(spaceId: string, day: string, label: string): string {
    const events = listTimelineEvents(spaceId, { day, limit: 120 });
    const spaceLabel = getSpace(spaceId)?.title || spaceId;

    if (events.length === 0) {
        return `[TOOL_RESULT] ${label} (${day}) timeline for ${spaceLabel} is empty.`;
    }

    const sorted = events.slice().sort((a, b) => a.happened_at.localeCompare(b.happened_at));
    return `[TOOL_RESULT] ${label} (${day}) timeline for ${spaceLabel}:\n${sorted.map(formatTimelineLine).join('\n')}`;
}

export function renderJournalRange(spaceId: string, range: JournalRange): string {
    const today = getLocalDayKey();

    if (range === 'today') {
        return renderSingleDay(spaceId, today, 'Today');
    }

    if (range === 'yesterday') {
        return renderSingleDay(spaceId, shiftDayKey(today, -1), 'Yesterday');
    }

    const fromDay = shiftDayKey(today, -6);
    const events = listTimelineEvents(spaceId, { fromDay, toDay: today, limit: 300 });
    const spaceLabel = getSpace(spaceId)?.title || spaceId;

    if (events.length === 0) {
        return `[TOOL_RESULT] Week (${fromDay} -> ${today}) timeline for ${spaceLabel} is empty.`;
    }

    const grouped = new Map<string, TimelineEvent[]>();
    for (const event of events) {
        const list = grouped.get(event.day) || [];
        list.push(event);
        grouped.set(event.day, list);
    }

    const sections = Array.from(grouped.keys())
        .sort((left, right) => right.localeCompare(left))
        .map((day) => {
            const dayEvents = (grouped.get(day) || [])
                .slice()
                .sort((a, b) => a.happened_at.localeCompare(b.happened_at));
            const lines = dayEvents.map(formatTimelineLine).join('\n');
            return `${formatDayHeading(day)} (${day})\n${lines}`;
        });

    return `[TOOL_RESULT] Week (${fromDay} -> ${today}) timeline for ${spaceLabel}:\n${sections.join('\n\n')}`;
}
