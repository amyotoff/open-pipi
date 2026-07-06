import crypto from 'crypto';
import { createArtifact, getSpace, storeMessage } from '../db';
import { rememberWorkMemory } from './memory-write';
import { appendTimelineEvent } from './timeline';

export type WorkLens = 'plan' | 'research' | 'review';

type RunWorkLensInput = {
    spaceId: string;
    channel: string;
    channelRef: string;
    senderId: string;
    lens: WorkLens;
    requestText?: string;
};

function formatLensLabel(lens: WorkLens): string {
    if (lens === 'plan') return 'Plan';
    if (lens === 'research') return 'Research';
    return 'Review';
}

export function truncate(value: string, max: number): string {
    const trimmed = value.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function makeLensTitle(lens: WorkLens, requestText?: string): string {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const suffix = requestText ? ` — ${truncate(requestText, 48)}` : '';
    return `${formatLensLabel(lens)} ${stamp}${suffix}`;
}

function summarizeLensResult(lens: WorkLens, text: string): string {
    const firstContentLine = text
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*#\s]+/, '').trim())
        .find(Boolean);
    return `${formatLensLabel(lens)} output: ${truncate(firstContentLine || text, 160)}`;
}

export function formatLensPrompt(lens: WorkLens, requestText?: string): string {
    const focus = requestText?.trim();

    if (lens === 'plan') {
        return [
            '[SYSTEM WORK LENS] Respond in PLAN mode for this reply only.',
            '- Start with "Objective".',
            '- Then list 3-7 concrete next steps.',
            '- Then list blockers or unknowns.',
            '- Optimize for the smallest useful next actions, not for grand strategy.',
            `Focus: ${focus || 'Build a concise plan from the current space state and active context.'}`,
        ].join('\n');
    }

    if (lens === 'research') {
        return [
            '[SYSTEM WORK LENS] Respond in RESEARCH mode for this reply only.',
            '- Start with "Question".',
            '- Then "What we know".',
            '- Then "Gaps / uncertainty".',
            '- Then "Recommended next research steps" or "Answer" if the evidence is already sufficient.',
            '- Be explicit about uncertainty and avoid fake certainty.',
            `Focus: ${focus || 'Synthesize the current space state into a small research brief.'}`,
        ].join('\n');
    }

    return [
        '[SYSTEM WORK LENS] Respond in REVIEW mode for this reply only.',
        '- Findings come first and must be concrete.',
        '- Focus on bugs, regressions, inconsistencies, decision risks, or missing tests.',
        '- Order findings roughly by severity.',
        '- If there are no findings, say "No findings." and then mention residual risks briefly.',
        '- After findings, include: Risks, Open questions, Next step.',
        `Focus: ${focus || 'Review the current space state and recent work.'}`,
    ].join('\n');
}

async function getConversationContext() {
    return await import('./context-composer');
}

async function getLlmRuntime() {
    return await import('./llm');
}

function maybePersistLensArtifact(args: { spaceId: string; lens: WorkLens; requestText?: string; text: string }): void {
    if (args.lens !== 'review') {
        return;
    }

    const artifactId = `art_${crypto.randomUUID()}`;
    const title = makeLensTitle(args.lens, args.requestText);
    const summary = summarizeLensResult(args.lens, args.text);

    createArtifact({
        id: artifactId,
        space_id: args.spaceId,
        source_message_id: null,
        kind: 'review',
        title,
        ref: args.text,
        summary,
    });

    appendTimelineEvent({
        spaceId: args.spaceId,
        type: 'review.generated',
        refType: 'artifact_db',
        refId: artifactId,
        summary: `Generated review artifact "${title}".`,
        details: {
            kind: 'review',
            title,
        },
    });
}

export async function runWorkLensForSpace(input: RunWorkLensInput): Promise<string> {
    const { composeConversationContext } = await getConversationContext();
    const { processWithLLM } = await getLlmRuntime();

    const { llmMessages } = composeConversationContext({
        spaceId: input.spaceId,
        senderId: input.senderId,
        channelRef: input.channelRef,
    });

    const prompt = formatLensPrompt(input.lens, input.requestText);
    let response: Awaited<ReturnType<typeof processWithLLM>>;
    try {
        response = await processWithLLM([...llmMessages, { role: 'user', content: prompt }], {
            chatId: input.channel === 'telegram' ? input.channelRef : undefined,
            userId: input.senderId,
            spaceId: input.spaceId,
            channel: input.channel,
            channelRef: input.channelRef,
        });
    } catch (err) {
        console.error(`[work-lenses] LLM call failed for lens=${input.lens}:`, err);
        return `${formatLensLabel(input.lens)} lens failed — LLM unavailable. Try again in a moment.`;
    }

    const text = response.text?.trim();
    if (!text) {
        return `${formatLensLabel(input.lens)} lens had nothing useful to add just now.`;
    }

    storeMessage({
        id: `bot-lens-${input.channel}-${input.lens}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        space_id: input.spaceId,
        channel_ref: input.channelRef,
        sender_id: 'jivs',
        content: text,
        timestamp: new Date().toISOString(),
        is_bot: 1,
    });

    rememberWorkMemory(
        input.spaceId,
        `lens_${input.lens}`,
        `Generated ${input.lens} lens output: ${truncate(text, 240)}`,
        {
            salience: input.lens === 'review' ? 0.5 : 0.4,
            source: 'work_lens',
        }
    );

    maybePersistLensArtifact({
        spaceId: input.spaceId,
        lens: input.lens,
        requestText: input.requestText,
        text,
    });
    const space = getSpace(input.spaceId);
    appendTimelineEvent({
        spaceId: input.spaceId,
        type: `${input.lens}.generated`,
        refType: 'space',
        refId: input.spaceId,
        summary: `Generated ${input.lens} output for ${space?.title || input.spaceId}.`,
        details: {
            lens: input.lens,
            request_text: input.requestText || null,
        },
    });

    return text;
}
