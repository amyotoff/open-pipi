import { buildTelegramSpaceId, getTask, logEvent, storeMessage } from '../db';
import { processWithLLM, processWithVision } from '../core/llm';
import { processWithOllama } from '../core/ollama';
import { sendSpaceFile, sendSpaceMessage } from '../channels/runtime';
import { composeConversationContext } from '../core/context-composer';
import { BRIEF_PIN_HOURS, createBriefPage, shouldCreateDailyBriefPage } from '../core/brief-pages';
import { logError, logInfo, summarizeError, summarizeText } from '../utils/logging';
import { addSpanAttributes, addSpanEvent, recordActiveSpanException, withSpan } from '../observability';
import { classifyMessageRoute } from '../core/local-triage';
import type { MessageOptions } from '../channels/_types';

/** An empty options object is noise; callers that pass nothing should pass nothing. */
function messageOptions(options: MessageOptions): MessageOptions | undefined {
    return Object.keys(options).length > 0 ? options : undefined;
}

function isNoSendSentinel(text: string): boolean {
    const meaningfulLines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        // A malformed repeated sentinel used to reach addDailyBriefLink, which
        // appended this operational note and made the noise even harder to
        // recognize on the next turn.
        .filter((line) => !/^brief:\s/i.test(line));

    if (meaningfulLines.length === 0) return false;

    return meaningfulLines.every((line) => {
        const normalized = line
            .replace(/^["'`]+|["'`.!?]+$/g, '')
            .replace(/^\[\s*|\s*\]$/g, '')
            .replace(/[\s-]+/g, '_')
            .toUpperCase();

        return normalized === 'NO_SEND';
    });
}

const UNSOLICITED_TAIL_START =
    /^(?:если\s+(?:(?:появятся|будут|возникнут)\s+(?:новые\s+)?(?:вводные|вопросы|задачи|изменения)|(?:что(?:-то)?\s+)?понадобится|нужно\s+будет)|могу\s+(?:также|ещ[её])|также\s+могу|я\s+на\s+связи|обращай(?:ся|тесь)|дай(?:те)?\s+знать|пиши(?:те)?\b|let\s+me\s+know|feel\s+free|i\s+can\s+also|i(?:'m|\s+am)\s+(?:here|available))/i;
const GOOGLE_DOCS_TOPIC = /(?:google\s+docs?|google[-\s]?док(?:умент)?|гугл[-\s]?док(?:умент)?)/i;

/**
 * Models like to append empty invitations to continue the conversation.
 * Removing only trailing paragraphs/sentences keeps useful conditional
 * instructions intact while preventing "if anything changes, I'm here" noise.
 */
function stripUnsolicitedTail(text: string): string {
    const blocks = text
        .trim()
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);

    while (blocks.length > 0 && UNSOLICITED_TAIL_START.test(blocks[blocks.length - 1])) {
        blocks.pop();
    }

    if (blocks.length === 0) return '';

    const lastIndex = blocks.length - 1;
    blocks[lastIndex] = blocks[lastIndex]
        .replace(
            /(?:\s+)(если\s+(?:(?:появятся|будут|возникнут)\s+(?:новые\s+)?(?:вводные|вопросы|задачи|изменения)|(?:что(?:-то)?\s+)?понадобится|нужно\s+будет)[\s\S]*)$/i,
            ''
        )
        .trim();

    return blocks.filter(Boolean).join('\n\n').trim();
}

function stripUnsolicitedGoogleDocs(text: string, currentMessage: string): string {
    if (GOOGLE_DOCS_TOPIC.test(currentMessage)) return text;

    return text
        .split(/\r?\n/)
        .filter((line) => !GOOGLE_DOCS_TOPIC.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function addDailyBriefLink(input: { taskId?: string; spaceId: string; responseText: string }): {
    text: string;
    pin: boolean;
    url: string | null;
    filePath: string | null;
    fileName: string | null;
} {
    if (!input.taskId) {
        return { text: input.responseText, pin: false, url: null, filePath: null, fileName: null };
    }

    const task = getTask(input.taskId);
    if (!shouldCreateDailyBriefPage(task)) {
        return { text: input.responseText, pin: false, url: null, filePath: null, fileName: null };
    }

    const page = createBriefPage({
        spaceId: input.spaceId,
        taskTitle: task.title,
        text: input.responseText,
    });
    if (!page.url) {
        return {
            text: `${input.responseText}\n\nBrief: HTML-файл прикреплю отдельным сообщением.`,
            pin: false,
            url: null,
            filePath: page.filePath,
            fileName: page.fileName,
        };
    }

    return {
        text: `${input.responseText}\n\nBrief: ${page.url}`,
        pin: true,
        url: page.url,
        filePath: null,
        fileName: null,
    };
}

/**
 * Legacy positional form. The leading argument used to be a Telegram context
 * and was never read — callers already pass null — so it is typed away rather
 * than dragging the SDK into the agent.
 */
export async function handleButlerMessage(
    unused: null,
    chatId: string,
    senderId: string,
    text: string,
    options?: { taskId?: string }
): Promise<void>;
export async function handleButlerMessage(input: {
    channel?: string;
    channelRef: string;
    senderId: string;
    text: string;
    spaceId?: string;
    taskId?: string;
    suppressNoSend?: boolean;
    correlationId?: string;
}): Promise<void>;
export async function handleButlerMessage(
    arg1: null | {
        channel?: string;
        channelRef: string;
        senderId: string;
        text: string;
        spaceId?: string;
        taskId?: string;
        suppressNoSend?: boolean;
        correlationId?: string;
    },
    chatId?: string,
    senderId?: string,
    text?: string,
    options?: { taskId?: string }
) {
    const input =
        typeof arg1 === 'object' && arg1 !== null && 'channelRef' in arg1
            ? {
                  channel: arg1.channel || 'telegram',
                  channelRef: arg1.channelRef,
                  senderId: arg1.senderId,
                  text: arg1.text,
                  taskId: arg1.taskId,
                  suppressNoSend: arg1.suppressNoSend,
                  correlationId: arg1.correlationId,
                  spaceId:
                      arg1.spaceId ||
                      (arg1.channel === 'telegram' || !arg1.channel
                          ? buildTelegramSpaceId(arg1.channelRef)
                          : `${arg1.channel}:${arg1.channelRef}`),
              }
            : {
                  channel: 'telegram',
                  channelRef: chatId!,
                  senderId: senderId!,
                  text: text!,
                  taskId: options?.taskId,
                  suppressNoSend: false,
                  correlationId: undefined,
                  spaceId: buildTelegramSpaceId(chatId!),
              };

    await withSpan(
        'assistant.butler.message',
        {
            attributes: {
                channel: input.channel,
                channel_ref: input.channelRef,
                sender_id: input.senderId,
                space_id: input.spaceId,
                task_id: input.taskId,
                ...summarizeText(input.text),
            },
        },
        async () => {
            const routing = await classifyMessageRoute(input.text);
            const simple = routing.route === 'simple';
            const spaceId = input.spaceId;
            addSpanAttributes({ 'app.butler.simple': simple });
            logInfo('BUTLER', 'triage_start', {
                channel: input.channel,
                ref: input.channelRef,
                sender: input.senderId,
                simple,
                routing_source: routing.source,
                ...summarizeText(input.text),
            });

            let responseText: string;

            if (simple) {
                const { llmMessages, systemPrompt } = composeConversationContext({
                    spaceId,
                    senderId: input.senderId,
                    channelRef: input.channelRef,
                    messageLimit: 15,
                });
                const history = llmMessages
                    .filter((m) => m.role !== 'system')
                    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                    .join('\n');
                const prompt = history ? `${history}\nUser: ${input.text}` : input.text;

                const result = await processWithOllama(prompt, systemPrompt);
                responseText = result.text;
                addSpanAttributes({ 'app.butler.engine': result.fromOllama ? 'ollama' : 'gemini_fallback' });
                logEvent('triage', { simple: true, ollama: result.fromOllama, routing_source: routing.source });
                logInfo('BUTLER', 'triage_complete', {
                    engine: result.fromOllama ? 'ollama' : 'gemini_fallback',
                    ...summarizeText(responseText),
                });
            } else {
                const { llmMessages } = composeConversationContext({
                    spaceId,
                    senderId: input.senderId,
                    channelRef: input.channelRef,
                });
                const response = await processWithLLM(llmMessages, {
                    chatId: input.channel === 'telegram' ? input.channelRef : undefined,
                    userId: input.senderId,
                    spaceId,
                    channel: input.channel,
                    channelRef: input.channelRef,
                    taskId: input.taskId,
                });
                responseText = response.text;
                addSpanAttributes({ 'app.butler.engine': 'gemini' });
                logEvent('triage', { simple: false, ollama: false, routing_source: routing.source });
                logInfo('BUTLER', 'triage_complete', {
                    engine: 'gemini',
                    ...summarizeText(responseText),
                });
            }

            const unsanitizedResponseText = responseText;
            responseText = stripUnsolicitedGoogleDocs(stripUnsolicitedTail(responseText), input.text);
            if (!responseText && unsanitizedResponseText.trim()) {
                addSpanEvent('assistant.butler.reply_suppressed', { reason: 'unsolicited_tail_or_topic' });
                logInfo('BUTLER', 'reply_suppressed', {
                    task_id: input.taskId,
                    reason: 'unsolicited_tail_or_topic',
                });
                return;
            }

            if ((input.taskId || input.suppressNoSend) && isNoSendSentinel(responseText)) {
                addSpanEvent('assistant.butler.reply_suppressed', { reason: 'no_send_sentinel' });
                logInfo('BUTLER', 'reply_suppressed', {
                    task_id: input.taskId,
                    reason: 'no_send_sentinel',
                });
                return;
            }

            if (responseText) {
                const prepared = addDailyBriefLink({
                    taskId: input.taskId,
                    spaceId,
                    responseText,
                });

                addSpanEvent('assistant.butler.reply_sent', {
                    response_chars: prepared.text.length,
                    ...(prepared.url ? { brief_url: prepared.url } : {}),
                });
                // Addressed to the space, so an answer reaches every surface the
                // conversation is open on rather than only the one it came from.
                await sendSpaceMessage(
                    spaceId,
                    prepared.text,
                    messageOptions({
                        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
                        ...(prepared.pin
                            ? { pin: true, unpinAfterHours: BRIEF_PIN_HOURS, pinDisableNotification: true }
                            : {}),
                    })
                );

                if (prepared.filePath) {
                    const fileResult = await sendSpaceFile(spaceId, prepared.filePath, {
                        filename: prepared.fileName || undefined,
                        caption: 'Brief HTML',
                        pin: true,
                        unpinAfterHours: BRIEF_PIN_HOURS,
                        pinDisableNotification: true,
                    });
                    if (!fileResult.success) {
                        await sendSpaceMessage(
                            spaceId,
                            `Не смог прикрепить Brief HTML: ${fileResult.error || 'канал не поддерживает файлы'}.`
                        );
                    }
                }

                storeMessage({
                    id: `bot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    space_id: spaceId,
                    channel_ref: input.channelRef,
                    sender_id: 'jivs',
                    content: prepared.text,
                    timestamp: new Date().toISOString(),
                    is_bot: 1,
                });
            }
        }
    );
}

export interface ButlerPhotoInput {
    channel: string;
    channelRef: string;
    spaceId: string;
    senderId: string;
    caption: string;
    correlationId?: string;
    /**
     * Already fetched by the transport. The assistant reasons about an image,
     * not about a Telegram file id — resolving one needs a bot token, which is
     * exactly the kind of thing that must not reach an agent.
     */
    image: { base64: string; mimeType: string };
}

export async function handleButlerPhoto(input: ButlerPhotoInput) {
    await withSpan(
        'assistant.butler.photo',
        {
            attributes: {
                channel: input.channel,
                channel_ref: input.channelRef,
                sender_id: input.senderId,
                has_caption: Boolean(input.caption),
                ...summarizeText(input.caption),
            },
        },
        async () => {
            try {
                const { systemPrompt } = composeConversationContext({
                    spaceId: input.spaceId,
                    senderId: input.senderId,
                    channelRef: input.channelRef,
                });

                const userPrompt = input.caption
                    ? `The user sent a photo with this caption: "${input.caption}". Analyze the image and answer helpfully and directly.`
                    : 'The user sent a photo without a caption. Describe what you see, infer what is relevant, and suggest the most useful next step.';

                const visionResponse = await processWithVision(
                    systemPrompt,
                    userPrompt,
                    input.image.base64,
                    input.image.mimeType
                );

                if (visionResponse.text) {
                    addSpanEvent('assistant.butler.photo_reply_sent', { response_chars: visionResponse.text.length });
                    await sendSpaceMessage(
                        input.spaceId,
                        visionResponse.text,
                        messageOptions({
                            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
                        })
                    );

                    storeMessage({
                        id: `bot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                        space_id: input.spaceId,
                        channel: input.channel,
                        channel_ref: input.channelRef,
                        sender_id: 'jivs',
                        content: visionResponse.text,
                        timestamp: new Date().toISOString(),
                        is_bot: 1,
                    });
                }
            } catch (err: any) {
                recordActiveSpanException(err, { 'app.butler.photo_status': 'failed' });
                logError('BUTLER', 'photo_processing_failed', summarizeError(err));
                await sendSpaceMessage(input.spaceId, 'Не удалось обработать фото. Попробуй ещё раз.');
            }
        }
    );
}
