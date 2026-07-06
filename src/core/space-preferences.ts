import { getSpace, getSpaceByChannelRef } from '../db';
import { getGroundingPack } from './grounding-loader';
import { RuntimeExecutionContext, resolveSpaceIdFromExecutionContext } from './runtime-context';

// ---------------------------------------------------------------------------
// Shared JSON helpers
// ---------------------------------------------------------------------------

export function parseSpacePolicyRecord(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Operational settings (onboarding, channel mode)
// ---------------------------------------------------------------------------

export type SpaceOnboardingState = 'new' | 'active';
export type SpaceChannelMode = 'off' | 'notify_only' | 'inbox' | 'full';

export interface SpaceOperationalSettings {
    onboarding_state: SpaceOnboardingState;
    setup_version: number;
    channel_mode: SpaceChannelMode;
}

export type SpaceOperationalSettingsPatch = Partial<SpaceOperationalSettings> & Record<string, unknown>;

const DEFAULT_SETUP_VERSION = 1;
const DEFAULT_CHANNEL_MODE: SpaceChannelMode = 'full';
const DEFAULT_EXISTING_ONBOARDING_STATE: SpaceOnboardingState = 'active';

export function normalizeSpaceOnboardingState(
    value: unknown,
    fallback: SpaceOnboardingState = DEFAULT_EXISTING_ONBOARDING_STATE
): SpaceOnboardingState {
    return value === 'new' || value === 'active' ? value : fallback;
}

export function normalizeSpaceChannelMode(
    value: unknown,
    fallback: SpaceChannelMode = DEFAULT_CHANNEL_MODE
): SpaceChannelMode {
    return value === 'off' || value === 'notify_only' || value === 'inbox' || value === 'full' ? value : fallback;
}

export function normalizeSpaceSetupVersion(value: unknown, fallback: number = DEFAULT_SETUP_VERSION): number {
    const version = typeof value === 'number' ? Math.trunc(value) : Number(value);
    return Number.isFinite(version) && version >= 1 ? version : fallback;
}

export function resolveSpaceOperationalSettings(
    raw: string | null | undefined,
    options?: { defaultOnboardingState?: SpaceOnboardingState }
): SpaceOperationalSettings {
    const record = parseSpacePolicyRecord(raw);
    const defaultOnboardingState = options?.defaultOnboardingState || DEFAULT_EXISTING_ONBOARDING_STATE;

    return {
        onboarding_state: normalizeSpaceOnboardingState(record.onboarding_state, defaultOnboardingState),
        setup_version: normalizeSpaceSetupVersion(record.setup_version, DEFAULT_SETUP_VERSION),
        channel_mode: normalizeSpaceChannelMode(record.channel_mode, DEFAULT_CHANNEL_MODE),
    };
}

function filterUndefinedValues(record: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

// Known operational keys are normalized here so the rest of the app can treat
// policy_json as a typed settings source instead of re-validating stringly data.
export function mergeSpaceOperationalPolicy(
    raw: string | null | undefined,
    patch: SpaceOperationalSettingsPatch,
    options?: { defaultOnboardingState?: SpaceOnboardingState }
): Record<string, unknown> {
    const record = parseSpacePolicyRecord(raw);
    const baseSettings = resolveSpaceOperationalSettings(raw, options);
    const cleanPatch = filterUndefinedValues(patch);

    const merged = {
        ...record,
        ...cleanPatch,
        onboarding_state:
            'onboarding_state' in cleanPatch
                ? normalizeSpaceOnboardingState(cleanPatch.onboarding_state, baseSettings.onboarding_state)
                : baseSettings.onboarding_state,
        setup_version:
            'setup_version' in cleanPatch
                ? normalizeSpaceSetupVersion(cleanPatch.setup_version, baseSettings.setup_version)
                : baseSettings.setup_version,
        channel_mode:
            'channel_mode' in cleanPatch
                ? normalizeSpaceChannelMode(cleanPatch.channel_mode, baseSettings.channel_mode)
                : baseSettings.channel_mode,
    };

    return filterUndefinedValues(merged);
}

// ---------------------------------------------------------------------------
// Space preferences (locale, timezone, language)
// ---------------------------------------------------------------------------

export type SpacePreferences = {
    spaceId: string | null;
    timeZone: string;
    language: string;
    locale: string;
    channel: string | null;
    title: string | null;
    assistantPackId: string | null;
};

const DEFAULT_LANGUAGE = 'en';
const DEFAULT_TIME_ZONE = process.env.TZ || 'UTC';

export function normalizeLanguageTag(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().replace(/_/g, '-');
    return normalized || null;
}

export function getLocaleForLanguage(language: string | null | undefined): string {
    const normalized = normalizeLanguageTag(language);
    if (!normalized) return 'en-GB';
    if (normalized.startsWith('ru')) return 'ru-RU';
    if (normalized.startsWith('it')) return 'it-IT';
    if (normalized.startsWith('en')) return 'en-GB';
    return normalized;
}

export function isValidTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim()) return false;

    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
        return true;
    } catch {
        return false;
    }
}

function normalizeTimeZone(value: unknown): string | null {
    return isValidTimeZone(value) ? value.trim() : null;
}

export function resolveSpacePreferences(spaceId?: string | null): SpacePreferences {
    const normalizedSpaceId = typeof spaceId === 'string' && spaceId.trim() ? spaceId.trim() : null;
    const space = normalizedSpaceId ? getSpace(normalizedSpaceId) : undefined;
    const overrides = parseSpacePolicyRecord(space?.policy_json);
    const grounding = space?.grounding_pack_id ? getGroundingPack(space.grounding_pack_id) : null;

    const language =
        normalizeLanguageTag(overrides.default_language) ||
        normalizeLanguageTag(grounding?.default_language) ||
        DEFAULT_LANGUAGE;
    const timeZone =
        normalizeTimeZone(overrides.timezone) || normalizeTimeZone(grounding?.timezone) || DEFAULT_TIME_ZONE;

    return {
        spaceId: normalizedSpaceId,
        timeZone,
        language,
        locale: getLocaleForLanguage(language),
        channel: space?.channel || null,
        title: space?.title || null,
        assistantPackId: space?.assistant_pack_id || null,
    };
}

export function resolveExecutionSpacePreferences(context?: Partial<RuntimeExecutionContext>): SpacePreferences {
    return resolveSpacePreferences(resolveSpaceIdFromExecutionContext(context));
}

export function resolveReminderSpaceId(args: {
    spaceId?: string | null;
    channel?: string | null;
    channelRef?: string | null;
}): string | null {
    if (args.spaceId && args.spaceId.trim()) {
        return args.spaceId.trim();
    }

    if (args.channel && args.channelRef) {
        return getSpaceByChannelRef(args.channel, args.channelRef)?.id || null;
    }

    if (args.channelRef) {
        return getSpaceByChannelRef('telegram', args.channelRef)?.id || null;
    }

    return null;
}

export function formatDateTimeForSpace(
    dateInput: string | Date,
    options: { timeZone: string; locale?: string; includeTimeZone?: boolean }
): string {
    const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    if (Number.isNaN(date.getTime())) {
        return typeof dateInput === 'string' ? dateInput : date.toISOString();
    }

    const formatted = new Intl.DateTimeFormat(options.locale || 'en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: options.timeZone,
    }).format(date);

    return options.includeTimeZone ? `${formatted} (${options.timeZone})` : formatted;
}

function hasExplicitTimeZone(raw: string): boolean {
    return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
}

function extractOffsetMinutes(date: Date, timeZone: string): number | null {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const timeZoneName = parts.find((part) => part.type === 'timeZoneName')?.value;
    if (!timeZoneName) return null;
    if (timeZoneName === 'GMT' || timeZoneName === 'UTC') return 0;

    const match = timeZoneName.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i);
    if (!match) return null;

    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] || '0');
    return sign * (hours * 60 + minutes);
}

function getLocalDateParts(date: Date, timeZone: string): Record<string, string> {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    })
        .formatToParts(date)
        .reduce<Record<string, string>>((acc, part) => {
            if (part.type !== 'literal') {
                acc[part.type] = part.value;
            }
            return acc;
        }, {});
}

function parseLocalDateTimeInTimeZone(raw: string, timeZone: string): Date | null {
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] || '0');
    const minute = Number(match[5] || '0');
    const second = Number(match[6] || '0');
    const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    let candidateMs = naiveUtcMs;

    for (let attempt = 0; attempt < 4; attempt += 1) {
        const offsetMinutes = extractOffsetMinutes(new Date(candidateMs), timeZone);
        if (offsetMinutes === null) return null;
        const nextCandidateMs = naiveUtcMs - offsetMinutes * 60_000;
        if (nextCandidateMs === candidateMs) break;
        candidateMs = nextCandidateMs;
    }

    const candidate = new Date(candidateMs);
    const parts = getLocalDateParts(candidate, timeZone);
    if (
        parts.year !== String(year).padStart(4, '0') ||
        parts.month !== String(month).padStart(2, '0') ||
        parts.day !== String(day).padStart(2, '0') ||
        parts.hour !== String(hour).padStart(2, '0') ||
        parts.minute !== String(minute).padStart(2, '0') ||
        parts.second !== String(second).padStart(2, '0')
    ) {
        return null;
    }

    return candidate;
}

export function parseDateTimeInSpace(raw: string, timeZone: string): Date | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (hasExplicitTimeZone(trimmed)) {
        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const localDate = parseLocalDateTimeInTimeZone(trimmed, timeZone);
    if (localDate) return localDate;

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
