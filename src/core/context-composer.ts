import {
    getActiveProjectForSpace,
    getAllResidents,
    getMemberEffectiveAuthority,
    getMemoryEntries,
    getDirectContactStatuses,
    getRecentDirectMessagesForPerson,
    getRecentMessagesForSpace,
    getResident,
    searchMessages,
    Message,
    MessageSearchHit,
    getSpace,
    getSpaceParticipants,
    getLatestArtifactByKind,
    Space,
} from '../db';
import { BOT_NAME_ALIASES } from '../config';
import { materializeAgentForSpace } from './agent-kernel';
import { LLMMessage } from './llm';
import { resolveAllowedCapabilities, resolveSpacePolicy } from './policy';
import { parseSpacePolicyRecord } from './space-preferences';
import { getMemoryContext } from './memory-context';
import { getWorkspaceSnapshot } from './workspace';
import { listWorkflowTemplatesForPack } from './workflows';
import { ensureActiveMemorySprint } from './memory-sprint';
import { resolveChannelRefFromExecutionContext } from './runtime-context';
import { getGroundingContext } from './grounding-context';
import { logInfo } from '../utils/logging';

/**
 * Build a human-readable chat type label so the LLM always knows
 * whether it is in a DM or a group — and with whom.
 */
function buildChatTypeLabel(space: Space | undefined, senderName: string, participantCount: number): string {
    const kind = space?.kind || 'unknown';
    if (kind === 'direct_chat') {
        return `direct (private conversation with ${senderName})`;
    }
    if (kind === 'group_chat') {
        const title = space?.title || space?.external_ref || 'unnamed';
        return `group "${title}" (${participantCount} participants)`;
    }
    return kind;
}

// Context window budget — keeps the assembled prompt within Gemini's safe limits.
// The system prompt is unbounded (packs, grounding, memory are naturally small);
// history is the main variable-size section and gets capped here.
const MAX_HISTORY_CHARS = 80_000;
const MAX_HISTORY_MESSAGES = 60;

// Onboarding / Curiosity Mode constants
const ONBOARDING_MAX_AGE_DAYS = 14;
const ONBOARDING_MEMORY_THRESHOLD = 15;
const PRIVATE_CONTINUITY_MESSAGE_LIMIT = 8;
const CROSS_SPACE_MESSAGE_LIMIT = 8;

const CROSS_SPACE_TRIGGER_PATTERN =
    /(друг(ой|ом|их)|внешн|партнер|партнёр|клиент|чат[аеуы]?|групп[аеуы]?|там\b|что\s+там|че\s+там|чё\s+там|other chat|another chat|client chat|partner chat)/i;
const TOPIC_PREFIX_PATTERN = /(?:по|про|о|об|about|re|regarding)\s+([а-яёa-z0-9][а-яёa-z0-9\s_-]{2,80})/gi;

const CROSS_SPACE_STOP_WORDS = new Set([
    ...BOT_NAME_ALIASES,
    'ало',
    'алло',
    'чат',
    'чате',
    'чата',
    'чатик',
    'другой',
    'другом',
    'других',
    'группа',
    'группе',
    'там',
    'что',
    'чего',
    'че',
    'чё',
    'про',
    'по',
    'об',
    'для',
    'как',
    'наш',
    'нас',
    'нам',
    'мне',
    'оно',
    'она',
    'они',
    'это',
    'его',
    'нее',
    'него',
    'них',
    'сейчас',
    'интересного',
    'интересно',
    'интересн',
    'есть',
    'the',
    'chat',
    'other',
    'another',
]);

function isSystemCronMessage(message: Message): boolean {
    return !message.is_bot && (message.sender_id || message.sender_tg_id) === 'system_cron';
}

function isNoSendHistoryNoise(message: Message): boolean {
    if (!message.is_bot) return false;

    const lines = message.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^brief:\s/i.test(line));

    return (
        lines.length > 0 &&
        lines.every((line) => {
            const normalized = line
                .replace(/^["'`]+|["'`.!?]+$/g, '')
                .replace(/^\[\s*|\s*\]$/g, '')
                .replace(/[\s-]+/g, '_')
                .toUpperCase();
            return normalized === 'NO_SEND';
        })
    );
}

/**
 * Scheduled prompts and their immediate bot reports have their own task-run
 * audit trail. Keeping them in ordinary chat history caused the model to
 * imitate old rituals and repeated NO_SEND sentinels. A scheduled turn still
 * receives its current prompt, but not prior cron conversations.
 */
function filterOperationalHistory(messages: Message[], currentSenderId: string): Message[] {
    const filtered: Message[] = [];
    let suppressNextBot = false;

    for (const message of messages) {
        if (isSystemCronMessage(message)) {
            suppressNextBot = true;
            continue;
        }

        if (suppressNextBot && message.is_bot) {
            suppressNextBot = false;
            continue;
        }
        suppressNextBot = false;

        if (!isNoSendHistoryNoise(message)) {
            filtered.push(message);
        }
    }

    if (currentSenderId === 'system_cron') {
        const currentPrompt = [...messages].reverse().find(isSystemCronMessage);
        if (currentPrompt) filtered.push(currentPrompt);
    }

    return filtered;
}

function formatPrivateTimestamp(iso: string): string {
    return iso.substring(0, 16).replace('T', ' ');
}

function buildPrivateContinuityBlock(
    space: Space | undefined,
    senderId: string,
    residentMap: Record<string, string>,
    participants: any[]
): string {
    if (space?.kind !== 'group_chat' || !space.channel) return '';

    const parts: string[] = [
        '[PRIVATE_CONTINUITY]',
        'Private context policy: the current speaker may refer to their own DM with the assistant; use only their own DM transcript for content. For other participants, expose contact status only, not private message content.',
    ];

    const directMessages = getRecentDirectMessagesForPerson(space.channel, senderId, PRIVATE_CONTINUITY_MESSAGE_LIMIT);
    if (directMessages.length > 0) {
        const lines = directMessages.map((message) => {
            const author = message.is_bot
                ? 'Assistant'
                : residentMap[message.sender_id || message.sender_tg_id || senderId] || 'Current speaker';
            return `- [${formatPrivateTimestamp(message.timestamp)}] ${author}: ${message.content}`;
        });
        parts.push(`Current speaker's recent DM transcript:\n${lines.join('\n')}`);
    } else {
        parts.push("Current speaker's recent DM transcript: none recorded.");
    }

    const participantIds = participants.map((p) => p.person_id || p.tg_id).filter(Boolean);
    const contactPersonIds = [...new Set([...participantIds, ...Object.keys(residentMap)])];
    const statuses = getDirectContactStatuses(space.channel, contactPersonIds);
    if (statuses.length > 0) {
        const lines = statuses.map((status) => {
            const name = residentMap[status.person_id] || status.person_id;
            return `- ${name} last contacted the assistant in DM at ${formatPrivateTimestamp(status.last_inbound_at)} (${status.inbound_count} inbound message${status.inbound_count === 1 ? '' : 's'} recorded).`;
        });
        parts.push(`Known DM contact status:\n${lines.join('\n')}`);
    } else {
        parts.push('Known DM contact status: no DMs are recorded for known people.');
    }

    return `\n${parts.join('\n')}`;
}

function trimHistorySnippet(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    return normalized.length > 180 ? `${normalized.substring(0, 180)}...` : normalized;
}

function stemSearchToken(token: string): string {
    if (/^[а-яё]{5,}$/i.test(token)) {
        return token.replace(
            /(ами|ями|ого|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ой|ей|ом|ем|ах|ях|ам|ям|ию|ью|ия|ья|а|я|ы|и|е|у|ю|о)$/i,
            ''
        );
    }
    return token;
}

function tokenizeCrossSpaceTopic(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/@\w+/g, ' ')
        .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !CROSS_SPACE_STOP_WORDS.has(token))
        .map(stemSearchToken)
        .filter((token) => token.length >= 4 && !CROSS_SPACE_STOP_WORDS.has(token));
}

function extractCrossSpaceSearchTerms(latestUserTexts: string[]): string[] {
    const joined = latestUserTexts.join('\n');
    const terms: string[] = [];
    let match: RegExpExecArray | null;

    TOPIC_PREFIX_PATTERN.lastIndex = 0;
    while ((match = TOPIC_PREFIX_PATTERN.exec(joined))) {
        terms.push(...tokenizeCrossSpaceTopic(match[1]));
    }

    if (terms.length === 0) {
        terms.push(...tokenizeCrossSpaceTopic(joined));
    }

    return [...new Set(terms)].slice(0, 5);
}

function formatCrossSpaceHit(hit: MessageSearchHit): string {
    const when = hit.timestamp.substring(0, 16).replace('T', ' ');
    const where = hit.space_title || hit.space_id || hit.channel_ref;
    const who = hit.is_bot ? 'Assistant' : hit.sender_name || hit.sender_id || 'unknown';
    return `- [${when}] ${where} / ${who}: ${trimHistorySnippet(hit.content)}`;
}

function buildCrossSpaceLookupBlock(input: {
    spaceId: string;
    recentMessages: Message[];
    residentRole?: string | null;
    effectiveAuthority?: number | null;
}): string {
    const isOwnerLike = input.residentRole === 'owner' || (input.effectiveAuthority ?? 0) >= 1000;
    if (!isOwnerLike) return '';

    const recentUserTexts = input.recentMessages
        .filter((message) => !message.is_bot)
        .map((message) => message.content)
        .slice(-4);
    if (recentUserTexts.length === 0) return '';

    const joinedRecentUserText = recentUserTexts.join('\n');
    const latestUserText = recentUserTexts[recentUserTexts.length - 1];
    const asksForAnotherSpace =
        CROSS_SPACE_TRIGGER_PATTERN.test(joinedRecentUserText) ||
        (/я\s+про|про\s+него|про\s+нее|про\s+них/i.test(latestUserText) &&
            CROSS_SPACE_TRIGGER_PATTERN.test(joinedRecentUserText));
    if (!asksForAnotherSpace) return '';

    const searchTerms = extractCrossSpaceSearchTerms(recentUserTexts);
    const hitsByKey = new Map<string, MessageSearchHit>();
    for (const term of searchTerms) {
        for (const hit of searchMessages(term, { limit: CROSS_SPACE_MESSAGE_LIMIT })) {
            if (!hit.space_id || hit.space_id === input.spaceId) continue;
            const key = `${hit.space_id}:${hit.timestamp}:${hit.sender_id || ''}:${hit.content}`;
            if (!hitsByKey.has(key)) {
                hitsByKey.set(key, hit);
            }
        }
    }

    const hits = [...hitsByKey.values()]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, CROSS_SPACE_MESSAGE_LIMIT)
        .reverse();

    const parts = [
        '\n[CROSS_SPACE_LOOKUP]',
        'The current conversation history contains only the current space. The owner appears to be asking about another tracked chat, client chat, partner chat, or topic in another space.',
        searchTerms.length > 0
            ? `Candidate search terms: ${searchTerms.join(', ')}`
            : 'Candidate search terms: none extracted.',
    ];

    if (hits.length > 0) {
        parts.push(`Relevant recent matches from other tracked spaces:\n${hits.map(formatCrossSpaceHit).join('\n')}`);
    } else {
        parts.push('Automatic lookup found no matching messages in other tracked spaces.');
    }

    parts.push(
        'Instruction: answer from other-space evidence when present. If evidence is missing or too thin, call chat_search with scope="all_spaces" before concluding there were no messages. Do not answer as if the user meant only the current chat unless they explicitly say so.'
    );

    return parts.join('\n');
}

/**
 * Compute the onboarding context injection for a space.
 * Returns the [ONBOARDING] block if the space is young and memory is sparse,
 * or an empty string if the bot is already "settled in".
 */
function buildOnboardingInjection(
    space: Space | undefined,
    spaceId: string,
    packHints: string[] | undefined,
    policy: Record<string, unknown>,
    participants: any[]
): string {
    // Manual override: owner already finished onboarding
    if (policy.onboarding_complete === true) return '';
    if (!space?.created_at) return '';

    const ageMs = Date.now() - new Date(space.created_at).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    if (ageDays > ONBOARDING_MAX_AGE_DAYS) return '';

    // Count memory density: space + work + person entries (and habits)
    const spaceMemory = getMemoryEntries('space', spaceId, undefined, 50);
    const workMemory = getMemoryEntries('work', spaceId, undefined, 50);
    let personDensity = 0;
    for (const p of participants) {
        const id = p.person_id || p.tg_id;
        const mems = getMemoryEntries('person', id, undefined, 5);
        if (mems.length > 0) personDensity++;
    }

    const density = spaceMemory.length + workMemory.length + personDensity;
    if (density >= ONBOARDING_MEMORY_THRESHOLD) return '';

    const hintsBlock =
        packHints && packHints.length > 0
            ? `Pack-specific priorities to learn first:\n${packHints.map((h, i) => `   ${i + 1}. ${h}`).join('\n')}`
            : 'No pack-specific priorities defined. Focus on understanding the people, processes, and goals of this space.';

    logInfo('CONTEXT', 'onboarding_active', {
        space_id: spaceId,
        age_days: ageDays,
        memory_density: density,
        hint_count: packHints?.length || 0,
    });

    return `\n[ONBOARDING]
You are still learning this space. Treat this as quiet background context, not something to announce.
Your priority is to build a useful working map of this space gradually and autonomously.

Rules:
1. SELF-RESEARCH FIRST. Before asking people, try to find the answer yourself:
   - Use browse_web or web search to check the company/project website.
   - Use workspace file tools if a workspace is configured.
   - Use memory_recall and chat_search to mine existing conversation history.
2. ASK SMART. If self-research fails, ask at most ONE focused clarifying question per interaction.
   Do not ask generic questions. Ask specific ones that unblock your work.
3. RECORD EVERYTHING. Every useful fact you discover or are told — immediately save it via
   memory_remember, resident_learn_habit, or grounding_add_override as appropriate.
   Do not wait. Do not batch. Record inline.
4. ${hintsBlock}
5. Do NOT announce onboarding mode, day numbers, knowledge density, thresholds, or fact quotas. Never say you need "N facts" to settle in.
6. If someone asks whether you are settling in, answer briefly and naturally. Do not turn it into a questionnaire.`;
}

function buildExternalGroupSelfRegulationBlock(space: Space | undefined): string {
    const policy = parseSpacePolicyRecord(space?.policy_json);
    if (space?.kind !== 'group_chat' || policy.external_group_enabled !== true) return '';

    const mode = policy.external_group_mode === 'auto' ? 'auto' : 'mention_only';
    const title = space?.title || space?.external_ref || 'this external group';

    return `\n[EXTERNAL_GROUP_SELF_REGULATION]
This is an external client/partner group: ${title}.
Current routing mode: ${mode}.

Use high self-regulation here. Self-regulation is not "always choose the best strategy"; it is noticing context, choosing a strategy that is appropriate now, and changing strategy when the situation changes.

Three-part flexibility loop:
1. Context sensitivity: before replying, identify what is happening right now. Is the group asking you directly, making a decision, aligning on logistics, venting, negotiating, or just chatting?
2. Strategy repertoire: choose from several response strategies:
   - stay silent when your contribution would add noise;
   - acknowledge briefly when the group only needs receipt;
   - ask one precise clarifying question when ambiguity blocks action;
   - summarize neutrally when the thread is scattered;
   - extract decisions, owners, and next steps when coordination is needed;
   - offer a draft or artifact when the work is too large for chat.
3. Strategy switching: if your current approach is not helping, change it. If people ignore you, shorten and reduce frequency. If they correct you, update your assumptions. If the chat becomes sensitive, slow down and ask before acting.

External group rules:
- Be useful, not performative. Prefer short, concrete messages.
- Do not dominate the thread or answer every message.
- Do not expose private memory or internal reasoning.
- Treat non-owners as legitimate participants in this external space, but do not execute high-impact actions without owner/admin approval.
- If silence is the most appropriate response after you were routed into this turn, reply exactly [NO_SEND].`;
}

export interface ConversationContext {
    llmMessages: LLMMessage[];
    systemPrompt: string;
    spaceId: string;
    assistantPackId: string;
    groundingPackId: string;
}

export interface ComposeConversationInput {
    spaceId: string;
    senderId: string;
    channelRef?: string;
    messageLimit?: number;
}

export function composeConversationContext(input: ComposeConversationInput): ConversationContext {
    const { spaceId, senderId, messageLimit = 40 } = input;
    const recentMessages = filterOperationalHistory(getRecentMessagesForSpace(spaceId, messageLimit), senderId);
    const space = getSpace(spaceId);
    const assistantAgent = materializeAgentForSpace(spaceId);
    const systemPrompt = assistantAgent.system_prompt;
    const policy = resolveSpacePolicy(spaceId);
    const allowedCapabilities = resolveAllowedCapabilities(policy);
    const activeSprint = ensureActiveMemorySprint(spaceId);
    const activeProject = getActiveProjectForSpace(spaceId);
    const resident = getResident(senderId);
    const effectiveAuthority = getMemberEffectiveAuthority(spaceId, senderId);
    const channelRef = input.channelRef || resolveChannelRefFromExecutionContext({ spaceId, channel: space?.channel });
    const groundingContext = getGroundingContext(spaceId);

    const name = resident?.nickname || resident?.display_name || resident?.username || 'Unknown';
    let residentContext = resident
        ? `Current speaker: ${name} (person_id: ${senderId}, role: ${resident.role}${effectiveAuthority !== null ? `, authority: ${effectiveAuthority}` : ''})`
        : `Current speaker: unknown participant (person_id: ${senderId})`;

    if (resident?.habits) {
        residentContext += `\nKnown habits and preferences: ${resident.habits}`;
    }

    const participants = getSpaceParticipants(spaceId);
    const allResidents = getAllResidents();
    const residentMap: Record<string, string> = {};

    for (const r of participants.length > 0 ? participants : allResidents) {
        const personId = r.person_id || r.tg_id;
        residentMap[personId] = r.nickname || r.display_name || r.username || `User ${personId}`;
    }
    for (const r of allResidents) {
        const personId = r.person_id || r.tg_id;
        if (!personId || residentMap[personId]) continue;
        residentMap[personId] = r.nickname || r.display_name || r.username || `User ${personId}`;
    }

    const memoryContext = getMemoryContext({
        residentId: senderId,
        spaceId,
        chatId: space?.channel === 'telegram' ? channelRef : undefined,
        projectId: activeProject?.id,
    });

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: process.env.TZ || undefined,
    });
    const timeStr = now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: process.env.TZ || undefined,
    });
    const localSearchDate = now.toLocaleDateString('it-IT', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: process.env.TZ || undefined,
    });

    const residentDirectory =
        participants.length > 0
            ? participants
                  .map((p) => {
                      const flags = Object.entries(p.trust_flags)
                          .filter(([, value]) => value)
                          .map(([key]) => key.replace(/^can_/, ''))
                          .join(', ');
                      const personId = p.person_id || p.tg_id;
                      return `  ${residentMap[personId]} (person_id: ${personId}, role: ${p.membership_role}, authority: ${p.effective_authority}${flags ? `, trust: ${flags}` : ''})`;
                  })
                  .join('\n')
            : Object.entries(residentMap)
                  .map(([personId, displayName]) => `  ${displayName} (person_id: ${personId})`)
                  .join('\n');

    const chatTypeLabel = buildChatTypeLabel(space, name, participants.length);
    const privateContinuityBlock = buildPrivateContinuityBlock(space, senderId, residentMap, participants);

    const onboardingBlock = buildOnboardingInjection(
        space,
        spaceId,
        assistantAgent.onboarding_hints,
        policy,
        participants
    );
    const externalGroupSelfRegulationBlock = buildExternalGroupSelfRegulationBlock(space);
    const crossSpaceLookupBlock = buildCrossSpaceLookupBlock({
        spaceId,
        recentMessages,
        residentRole: resident?.role,
        effectiveAuthority,
    });

    const systemParts = [
        systemPrompt,
        space?.channel === 'telegram'
            ? `\n[RESPONSE_CONTRACT]
- Think and use tools as deeply as the work requires; keep the visible reply proportional.
- Lead with the answer, decision, or completed outcome. Do not restate the request.
- Default to at most 6 short lines, 3 bullets, and roughly 700 characters.
- Expand only when the user explicitly asks for detail or when omitting detail would make the result unsafe or unusable.
- Do not append generic offers such as "I can also..." or narrate routine internal work.
- Put long plans or evidence into an artifact and send only the takeaway plus the link.
- For scheduled initiative, investigate actively before deciding. Silence is correct only after a genuine review finds nothing material to report.`
            : '',
        `\n[ASSISTANT_PACK]\nPack: ${assistantAgent.id}\nPersona: ${assistantAgent.persona_id}\nCapabilities: ${assistantAgent.enabled_capabilities.join(', ')}`,
        assistantAgent.skills_doc ? `\n[SKILLS]\n${assistantAgent.skills_doc}` : '',
        groundingContext ? `\n${groundingContext}` : '',
        onboardingBlock,
        externalGroupSelfRegulationBlock,
        crossSpaceLookupBlock,
        `\n[CORE_TOOLBOX]\nPrefer the unified core tools named exactly as these primitives before reaching for lower-level legacy tools.\nPrimitives:\n${assistantAgent.core_toolbox.primitives
            .map(
                (entry) =>
                    `- ${entry.id}: ${entry.description}${entry.backing_capabilities.length > 0 ? ` (backed by ${entry.backing_capabilities.join(', ')})` : ''}`
            )
            .join('\n')}\nSystem capabilities:\n${assistantAgent.core_toolbox.system_capabilities
            .map(
                (entry) =>
                    `- ${entry.id}: ${entry.description}${entry.backing_capabilities.length > 0 ? ` (backed by ${entry.backing_capabilities.join(', ')})` : ''}`
            )
            .join('\n')}`,
        `\n[POLICY]\nbrowser: ${policy.browser}\ntasks: ${policy.tasks}\nmemory_sprint_days: ${policy.memory_sprint_days}\nsandbox_enabled: ${policy.sandbox_enabled}\naudit_trail: ${policy.audit_trail}\nallowed_capabilities: ${allowedCapabilities.join(', ')}\nworkspace_path: ${policy.workspace_path || 'none'}`,
        `\n[MEMORY_SPRINT]\nActive sprint: ${activeSprint.opened_at.substring(0, 10)} -> ${activeSprint.closes_at.substring(0, 10)} (${activeSprint.cadence_days} days)`,
        `\n[CONTEXT]\nNow: ${dateStr}, ${timeStr}\nLocal date for search queries: ${localSearchDate}\nChannel ref: ${channelRef || 'n/a'}\nSpace: ${spaceId}\nChat type: ${chatTypeLabel}\n${residentContext}` +
            `\n\n[PARTICIPANTS]\n${residentDirectory}\nImportant: every name in the conversation history refers to a different person. Do not confuse participants.`,
        `\n[HTML_ARTIFACTS]\nFor long or complex plans, research, reports, meeting notes, decision memos, or work breakdowns, prefer html_artifact_create and then reply with a short summary plus the returned link. Do not send a giant wall of text when an HTML artifact would be easier to read.`,
        privateContinuityBlock,
    ];

    if (activeProject) {
        const formatLinkList = (values: string[]) => (values.length > 0 ? values.slice(0, 5).join(', ') : 'none');
        systemParts.push(`\n[PROJECT]
Title: ${activeProject.title}
Slug: ${activeProject.slug}
State: ${activeProject.state}
Goal: ${activeProject.goal || 'none'}
Next step: ${activeProject.next_step || 'none'}
Preferred pack: ${activeProject.active_pack_id || 'none'}
Linked spaces: ${formatLinkList(activeProject.linked_spaces)}
Linked tasks: ${formatLinkList(activeProject.linked_tasks)}
Linked artifacts: ${formatLinkList(activeProject.linked_artifacts)}`);
    }

    if (policy.workspace_path) {
        const snapshot = getWorkspaceSnapshot(spaceId);
        const workspaceSummary = snapshot.exists
            ? `Root: ${snapshot.root}\nTop-level entries: ${snapshot.entries.length > 0 ? snapshot.entries.join(', ') : 'empty'}`
            : `Root: ${snapshot.root}\nStatus: missing or unavailable`;
        systemParts.push(
            `\n[WORKSPACE]\n${workspaceSummary}\nUse workspace tools for reading, searching, and saving artifacts when the task depends on local project files.`
        );

        const workflowTemplates = listWorkflowTemplatesForPack(assistantAgent.id);
        if (workflowTemplates.length > 0) {
            systemParts.push(
                `\n[WORKFLOWS]\nAvailable workflow templates: ${workflowTemplates.map((template) => template.id).join(', ')}.`
            );
        }
    }

    if (assistantAgent.pack_tools.length > 0) {
        systemParts.push(
            `\n[PACK_TOOLS]\nAvailable pack-local tools:\n${assistantAgent.pack_tools
                .map((tool) => `- ${tool.id}: ${tool.description}`)
                .join(
                    '\n'
                )}\nUse them when the pack-specific scripted output is more reliable than free-form recollection.`
        );
    }

    if (memoryContext) {
        systemParts.push(`\n${memoryContext}`);
    }

    const activePlan = getLatestArtifactByKind(spaceId, 'plan');
    const activeTaskList = getLatestArtifactByKind(spaceId, 'task_list');

    if (activePlan || activeTaskList) {
        const MAX_ARTIFACT_REF_CHARS = 4000;
        const truncateRef = (s: string) =>
            s.length > MAX_ARTIFACT_REF_CHARS ? s.slice(0, MAX_ARTIFACT_REF_CHARS) + '\n[…truncated]' : s;

        systemParts.push(
            `\n[ACTIVE_ARTIFACTS]\n` +
                (activePlan
                    ? `<attached_artifact id="${activePlan.id}" kind="plan" title="${activePlan.title}">\n${truncateRef(activePlan.ref)}\n</attached_artifact>\n`
                    : '') +
                (activeTaskList
                    ? `<attached_artifact id="${activeTaskList.id}" kind="task_list" title="${activeTaskList.title}">\n${truncateRef(activeTaskList.ref)}\n</attached_artifact>\n`
                    : '') +
                `\nNote: Use artifacts_update to mutate task lists. Use artifacts_create to replace a plan with a new one.`
        );
    }

    const finalSystemPrompt = systemParts.filter(Boolean).join('\n');
    const llmMessages: LLMMessage[] = [{ role: 'system', content: finalSystemPrompt }];

    // Build history messages from recent DB rows
    const historyMessages: LLMMessage[] = [];
    for (const msg of recentMessages) {
        if (msg.is_bot) {
            historyMessages.push({ role: 'assistant', content: msg.content });
        } else {
            const senderId = msg.sender_id || msg.sender_tg_id;
            const senderName = senderId
                ? residentMap[senderId] || (senderId === 'system_cron' ? '[SYSTEM]' : `User ${senderId}`)
                : 'Unknown';
            historyMessages.push({ role: 'user', content: `[${senderName}]: ${msg.content}` });
        }
    }

    // Context window safety net: drop oldest messages when history is too large.
    // This prevents prompt-overflow errors when a space has long conversations.
    let totalHistoryChars = historyMessages.reduce((sum, m) => sum + m.content.length, 0);
    let startIndex = 0;
    while (
        startIndex < historyMessages.length - 1 &&
        (totalHistoryChars > MAX_HISTORY_CHARS || historyMessages.length - startIndex > MAX_HISTORY_MESSAGES)
    ) {
        totalHistoryChars -= historyMessages[startIndex].content.length;
        startIndex++;
    }
    const trimmedHistory = historyMessages.slice(startIndex);
    const omittedMessages = startIndex;

    llmMessages.push(...trimmedHistory);

    logInfo('CONTEXT', 'window_prepared', {
        space_id: spaceId,
        system_chars: finalSystemPrompt.length,
        history_chars: totalHistoryChars,
        history_messages: trimmedHistory.length,
        omitted_messages: omittedMessages,
    });

    return {
        llmMessages,
        systemPrompt: finalSystemPrompt,
        spaceId,
        assistantPackId: assistantAgent.id,
        groundingPackId: space?.grounding_pack_id || 'jeeves_personal',
    };
}
