import { getDb, listSkillRequests, logEvent, Message, SkillRequest, Space } from '../db';
import { logInfo, logWarn, summarizeError, summarizeText } from '../utils/logging';
import { processWithLLM } from './llm';

const REVIEW_INTERVAL_MS = 48 * 60 * 60 * 1000;
const EVIDENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const COMPLETED_EVENT = 'atelier_self_review_completed';
const FAILED_EVENT = 'atelier_self_review_failed';
const SELF_REVIEW_USER_ID = 'system_self_review';

let reviewInFlight = false;

type ActiveSpaceEvidence = Space & {
    human_message_count: number;
    last_human_message_at: string | null;
};

type RequestSnapshot = {
    id: number;
    votes: number;
    description: string;
    userRequest: string;
};

export type AtelierSelfReviewStatus =
    | 'not_due'
    | 'in_flight'
    | 'skipped_no_active_space'
    | 'no_request'
    | 'request_created'
    | 'request_updated';

export interface AtelierSelfReviewResult {
    status: AtelierSelfReviewStatus;
    spaceId?: string;
    assistantPackId?: string;
    requestIds?: number[];
    nextDueAt?: string;
}

export interface AtelierSelfReviewOptions {
    force?: boolean;
    now?: Date;
}

export const ATELIER_SELF_REVIEW_SYSTEM_PROMPT = `You are running a private self-improvement review for an assistant.

Think hard about how the assistant can become more useful, productive, reliable, and worth keeping. Be ambitious in diagnosis and conservative in what you ask the Atelier to build.

This is an internal maintenance task:
- never address the user and never send a chat update;
- use evidence, not anxiety, vanity, or a desire to appear busy;
- distinguish a missing capability from a tone, prompt, discipline, or configuration problem;
- existing tools and capabilities should be used better before requesting new ones.`;

function truncate(value: string | null | undefined, maxLength: number): string {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isSystemCronMessage(message: Message): boolean {
    return !message.is_bot && (message.sender_id || message.sender_tg_id) === 'system_cron';
}

function isNoSendMessage(message: Message): boolean {
    if (!message.is_bot) return false;

    const meaningfulLines = message.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^brief:\s/i.test(line));

    return (
        meaningfulLines.length > 0 &&
        meaningfulLines.every((line) => {
            const normalized = line
                .replace(/^["'`]+|["'`.!?]+$/g, '')
                .replace(/^\[\s*|\s*\]$/g, '')
                .replace(/[\s-]+/g, '_')
                .toUpperCase();
            return normalized === 'NO_SEND';
        })
    );
}

function filterOperationalDialogue(messages: Message[]): Message[] {
    const kept: Message[] = [];
    let suppressCronReply = false;

    for (const message of messages) {
        if (isSystemCronMessage(message)) {
            suppressCronReply = true;
            continue;
        }

        if (suppressCronReply && message.is_bot) {
            suppressCronReply = false;
            continue;
        }

        suppressCronReply = false;
        if (!isNoSendMessage(message)) {
            kept.push(message);
        }
    }

    return kept;
}

function listActiveSpaces(cutoffIso: string): ActiveSpaceEvidence[] {
    return getDb()
        .prepare(
            `
        SELECT
            s.*,
            SUM(
                CASE
                    WHEN m.is_bot = 0
                     AND COALESCE(m.sender_tg_id, '') != 'system_cron'
                     AND m.timestamp >= ?
                    THEN 1 ELSE 0
                END
            ) AS human_message_count,
            MAX(
                CASE
                    WHEN m.is_bot = 0
                     AND COALESCE(m.sender_tg_id, '') != 'system_cron'
                    THEN m.timestamp
                END
            ) AS last_human_message_at
        FROM spaces s
        LEFT JOIN messages m
          ON COALESCE(m.space_id, 'telegram:' || m.chat_jid) = s.id
        WHERE UPPER(s.status) = 'ACTIVE'
        GROUP BY s.id
        ORDER BY
            human_message_count DESC,
            COALESCE(last_human_message_at, s.updated_at) DESC,
            s.id ASC
    `
        )
        .all(cutoffIso) as ActiveSpaceEvidence[];
}

function getRecentDialogue(spaceId: string, cutoffIso: string): Message[] {
    const messages = getDb()
        .prepare(
            `
        SELECT *, chat_jid AS channel_ref, sender_tg_id AS sender_id
        FROM messages
        WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ?
          AND timestamp >= ?
        ORDER BY timestamp DESC, rowid DESC
        LIMIT 180
    `
        )
        .all(spaceId, cutoffIso)
        .reverse() as Message[];

    return filterOperationalDialogue(messages).slice(-36);
}

function renderDialogue(messages: Message[]): string {
    if (messages.length === 0) return '- No meaningful recent human dialogue was found.';

    return messages
        .map((message) => {
            const role = message.is_bot ? 'ASSISTANT' : 'HUMAN';
            return `- ${message.timestamp} ${role}: ${truncate(message.content, 360)}`;
        })
        .join('\n');
}

function renderToolEvidence(cutoffIso: string): string {
    const rows = getDb()
        .prepare(
            `
        SELECT
            tl.tool_name,
            tl.status,
            COUNT(*) AS run_count,
            MAX(COALESCE(tl.error, '')) AS sample_error
        FROM tool_logs tl
        LEFT JOIN spaces s ON s.id = tl.space_id
        WHERE tl.started_at >= ?
          AND (tl.space_id IS NULL OR UPPER(s.status) = 'ACTIVE')
        GROUP BY tl.tool_name, tl.status
        ORDER BY
            CASE WHEN LOWER(tl.status) IN ('ok', 'success', 'completed') THEN 1 ELSE 0 END,
            run_count DESC,
            tl.tool_name ASC
        LIMIT 24
    `
        )
        .all(cutoffIso) as Array<{
        tool_name: string;
        status: string;
        run_count: number;
        sample_error: string;
    }>;

    if (rows.length === 0) return '- No tool executions were recorded in the evidence window.';

    return rows
        .map((row) => {
            const error = row.sample_error ? `; sample error: ${truncate(row.sample_error, 220)}` : '';
            return `- ${row.tool_name}: ${row.run_count} run(s), status=${row.status}${error}`;
        })
        .join('\n');
}

function renderOpenRequests(requests: SkillRequest[]): string {
    if (requests.length === 0) return '- No open requests for this assistant pack.';

    return requests
        .slice(0, 16)
        .map(
            (request) =>
                `- #${request.id} gap=${request.capability_gap || request.skill_name}; status=${request.status}; votes=${request.votes || 1}; ${truncate(request.description, 260)}`
        )
        .join('\n');
}

function snapshotRequests(requests: SkillRequest[]): Map<number, RequestSnapshot> {
    return new Map(
        requests
            .filter((request): request is SkillRequest & { id: number } => typeof request.id === 'number')
            .map((request) => [
                request.id,
                {
                    id: request.id,
                    votes: request.votes || 1,
                    description: request.description,
                    userRequest: request.user_request,
                },
            ])
    );
}

function changedRequestIds(before: Map<number, RequestSnapshot>, after: Map<number, RequestSnapshot>): number[] {
    const changed: number[] = [];

    for (const [id, current] of after) {
        const previous = before.get(id);
        if (
            !previous ||
            previous.votes !== current.votes ||
            previous.description !== current.description ||
            previous.userRequest !== current.userRequest
        ) {
            changed.push(id);
        }
    }

    return changed;
}

function findLastCompletedReviewAt(): string | undefined {
    const row = getDb()
        .prepare(
            `
        SELECT timestamp, details
        FROM event_log
        WHERE event_type = ?
        ORDER BY id DESC
        LIMIT 1
    `
        )
        .get(COMPLETED_EVENT) as { timestamp: string; details: string } | undefined;

    if (!row) return undefined;

    try {
        const details = JSON.parse(row.details || '{}') as { reviewed_at?: string };
        return details.reviewed_at || row.timestamp;
    } catch {
        return row.timestamp;
    }
}

export function isAtelierSelfReviewDue(lastCompletedAt: string | undefined, nowMs: number = Date.now()): boolean {
    if (!lastCompletedAt) return true;
    const lastMs = Date.parse(lastCompletedAt);
    return !Number.isFinite(lastMs) || nowMs - lastMs >= REVIEW_INTERVAL_MS;
}

export function buildAtelierSelfReviewPrompt(input: {
    nowIso: string;
    space: ActiveSpaceEvidence;
    activeSpaceCount: number;
    dialogue: Message[];
    toolEvidence: string;
    openRequests: SkillRequest[];
}): string {
    return `[ATELIER_SELF_REVIEW]
Review time: ${input.nowIso}
Assistant pack: ${input.space.assistant_pack_id}
Primary evidence space: ${input.space.id} (${input.space.title || input.space.external_ref})
Active spaces considered: ${input.activeSpaceCount}
Human messages in the last 14 days for the primary space: ${input.space.human_message_count}

RECENT MEANINGFUL DIALOGUE
${renderDialogue(input.dialogue)}

TOOL EXECUTION EVIDENCE
${input.toolEvidence}

CURRENT OPEN ATELIER REQUESTS
${renderOpenRequests(input.openRequests)}

Decision procedure:
1. Actively diagnose repeated friction, failed work, missing access, or work the assistant repeatedly cannot complete. Consider reliability and usefulness, not cosmetic cleverness.
2. Call atelier_list_requests with scope="pack" before making a request so you verify the live queue and avoid duplicates.
3. You may call consult_advisor once if the evidence creates a genuinely difficult product decision.
4. Request a capability only when all are true:
   - the need is supported by repeated or material evidence;
   - it would produce a concrete productivity or reliability improvement;
   - no existing tool, configuration, prompt adjustment, or better operating discipline solves it;
   - it is not already represented by an open Atelier request;
   - you can give it a stable snake_case capability_gap and a testable description.
5. At most ONE atelier_request_capability call is allowed in this review. Do not create a ticket and do not clear requests.
6. Do not request work merely to sound less verbose, appear proactive, or reassure yourself about being retained. Those are behavior problems unless a real missing capability is evidenced.
7. Do not send or propose a public chat message. This review is silent.

Finish with exactly one concise line:
NO_REQUEST: <why existing capabilities are sufficient for now>
or
REQUESTED: <capability_gap and concrete expected improvement>`;
}

function completedDetails(
    nowIso: string,
    status: AtelierSelfReviewStatus,
    extra?: Record<string, unknown>
): Record<string, unknown> {
    return {
        reviewed_at: nowIso,
        status,
        ...extra,
    };
}

export async function runAtelierSelfReviewIfDue(
    options: AtelierSelfReviewOptions = {}
): Promise<AtelierSelfReviewResult> {
    const now = options.now || new Date();
    const nowIso = now.toISOString();
    const lastCompletedAt = findLastCompletedReviewAt();

    if (!options.force && !isAtelierSelfReviewDue(lastCompletedAt, now.getTime())) {
        return {
            status: 'not_due',
            nextDueAt: new Date(Date.parse(lastCompletedAt!) + REVIEW_INTERVAL_MS).toISOString(),
        };
    }

    if (reviewInFlight) {
        return { status: 'in_flight' };
    }

    reviewInFlight = true;
    try {
        const cutoffIso = new Date(now.getTime() - EVIDENCE_WINDOW_MS).toISOString();
        const activeSpaces = listActiveSpaces(cutoffIso);
        const primarySpace = activeSpaces[0];

        if (!primarySpace) {
            logEvent(COMPLETED_EVENT, completedDetails(nowIso, 'skipped_no_active_space'));
            logInfo('ATELIER_SELF_REVIEW', 'skipped_no_active_space');
            return { status: 'skipped_no_active_space' };
        }

        const dialogue = getRecentDialogue(primarySpace.id, cutoffIso);
        const openRequestsBefore = listSkillRequests({
            assistantPackId: primarySpace.assistant_pack_id,
        });
        const beforeSnapshot = snapshotRequests(openRequestsBefore);
        const taskId = `system:atelier-self-review:${nowIso}`;
        const prompt = buildAtelierSelfReviewPrompt({
            nowIso,
            space: primarySpace,
            activeSpaceCount: activeSpaces.length,
            dialogue,
            toolEvidence: renderToolEvidence(cutoffIso),
            openRequests: openRequestsBefore,
        });

        logInfo('ATELIER_SELF_REVIEW', 'review_started', {
            space_id: primarySpace.id,
            assistant_pack_id: primarySpace.assistant_pack_id,
            active_spaces: activeSpaces.length,
            dialogue_messages: dialogue.length,
            open_requests: openRequestsBefore.length,
        });

        const response = await processWithLLM(
            [
                { role: 'system', content: ATELIER_SELF_REVIEW_SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            {
                userId: SELF_REVIEW_USER_ID,
                spaceId: primarySpace.id,
                channel: primarySpace.channel,
                channelRef: primarySpace.external_ref,
                taskId,
                allowedTools: ['atelier_list_requests', 'atelier_request_capability', 'consult_advisor'],
            }
        );

        const openRequestsAfter = listSkillRequests({
            assistantPackId: primarySpace.assistant_pack_id,
        });
        const afterSnapshot = snapshotRequests(openRequestsAfter);
        const requestIds = changedRequestIds(beforeSnapshot, afterSnapshot);
        const finalText = response.text.trim();

        let status: AtelierSelfReviewStatus;
        if (requestIds.length > 0) {
            status = requestIds.some((id) => !beforeSnapshot.has(id)) ? 'request_created' : 'request_updated';
        } else if (/^NO_REQUEST:\s*\S/im.test(finalText)) {
            status = 'no_request';
        } else {
            throw new Error(
                /^REQUESTED:/im.test(finalText)
                    ? 'Self-review claimed a request without changing the Atelier queue.'
                    : 'Self-review did not return a valid NO_REQUEST or REQUESTED decision.'
            );
        }

        logEvent(
            COMPLETED_EVENT,
            completedDetails(nowIso, status, {
                space_id: primarySpace.id,
                assistant_pack_id: primarySpace.assistant_pack_id,
                request_ids: requestIds,
                response_preview: truncate(finalText, 500),
            })
        );
        logInfo('ATELIER_SELF_REVIEW', 'review_completed', {
            status,
            space_id: primarySpace.id,
            request_ids: requestIds,
            ...summarizeText(finalText),
        });

        return {
            status,
            spaceId: primarySpace.id,
            assistantPackId: primarySpace.assistant_pack_id,
            requestIds,
            nextDueAt: new Date(now.getTime() + REVIEW_INTERVAL_MS).toISOString(),
        };
    } catch (error) {
        logEvent(FAILED_EVENT, {
            attempted_at: nowIso,
            ...summarizeError(error),
        });
        logWarn('ATELIER_SELF_REVIEW', 'review_failed', summarizeError(error));
        throw error;
    } finally {
        reviewInFlight = false;
    }
}
