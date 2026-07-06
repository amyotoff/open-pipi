import { Context } from 'telegraf';
import { buildTelegramSpaceId, getTask, logEvent, storeMessage } from '../db';
import { processWithLLM, processWithVision } from '../core/llm';
import { processWithOllama } from '../core/ollama';
import { sendChannelFile, sendChannelMessage } from '../channels/runtime';
import { bot } from '../channels/telegram';
import { composeConversationContext } from '../core/context-composer';
import { BRIEF_PIN_HOURS, createBriefPage, shouldCreateDailyBriefPage } from '../core/brief-pages';
import { logError, logInfo, summarizeError, summarizeText } from '../utils/logging';
import { addSpanAttributes, addSpanEvent, recordActiveSpanException, withSpan } from '../observability';

function isSimpleMessage(text: string): boolean {
    const t = text.toLowerCase().trim();
    if (/^(привет|здравствуй|хай|хей|добр(ое|ый|ой)|салют|здоров|йо)(?:$|[\s.!?,])/i.test(t)) return true;
    if (/^(спасибо|благодар|мерси|thx|thanks|спс|пасиб)(?:$|[\s.!?,])/i.test(t)) return true;
    if (
        /^(ок|окей|ладно|понял|ясно|хорошо|отлично|супер|класс|круто|ага|угу|да|нет|не надо|не нужно|ну ок)\s*[.!]?$/i.test(
            t
        )
    )
        return true;
    if (/^(пока|спокойной|до завтра|good night|доброй ночи|сладких снов)(?:$|[\s.!?,])/i.test(t)) return true;
    if (/^(который час|сколько время|какой день|какое число)\s*\??$/i.test(t)) return true;
    if (/^(как дела|что нового|как ты)\s*\??$/i.test(t)) return true;
    return false;
}

function isNoSendSentinel(text: string): boolean {
    const normalized = text
        .trim()
        .replace(/^["'`]+|["'`.!?]+$/g, '')
        .replace(/^\[\s*|\s*\]$/g, '')
        .replace(/[\s-]+/g, '_')
        .toUpperCase();

    return normalized === 'NO_SEND';
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

export async function handleButlerMessage(
    ctx: Context | null,
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
}): Promise<void>;
export async function handleButlerMessage(
    arg1:
        | Context
        | null
        | {
              channel?: string;
              channelRef: string;
              senderId: string;
              text: string;
              spaceId?: string;
              taskId?: string;
              suppressNoSend?: boolean;
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
            const simple = isSimpleMessage(input.text);
            const spaceId = input.spaceId;
            addSpanAttributes({ 'app.butler.simple': simple });
            logInfo('BUTLER', 'triage_start', {
                channel: input.channel,
                ref: input.channelRef,
                sender: input.senderId,
                simple,
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
                logEvent('triage', { simple: true, ollama: result.fromOllama });
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
                logEvent('triage', { simple: false, ollama: false });
                logInfo('BUTLER', 'triage_complete', {
                    engine: 'gemini',
                    ...summarizeText(responseText),
                });
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
                await sendChannelMessage(
                    input.channel,
                    input.channelRef,
                    prepared.text,
                    prepared.pin
                        ? {
                              pin: true,
                              unpinAfterHours: BRIEF_PIN_HOURS,
                              pinDisableNotification: true,
                          }
                        : undefined
                );

                if (prepared.filePath) {
                    const fileResult = await sendChannelFile(input.channel, input.channelRef, prepared.filePath, {
                        filename: prepared.fileName || undefined,
                        caption: 'Brief HTML',
                        pin: true,
                        unpinAfterHours: BRIEF_PIN_HOURS,
                        pinDisableNotification: true,
                    });
                    if (!fileResult.success) {
                        await sendChannelMessage(
                            input.channel,
                            input.channelRef,
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

export async function handleButlerPhoto(ctx: Context, chatId: string, senderId: string, caption: string) {
    const message = ctx.message as any;
    if (!message.photo || message.photo.length === 0) return;

    // Get the largest photo
    const photo = message.photo[message.photo.length - 1];

    await withSpan(
        'assistant.butler.photo',
        {
            attributes: {
                channel: 'telegram',
                channel_ref: chatId,
                sender_id: senderId,
                has_caption: Boolean(caption),
                ...summarizeText(caption),
            },
        },
        async () => {
            try {
                const file = await bot.telegram.getFile(photo.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${bot.telegram.token}/${file.file_path}`;

                const response = await fetch(fileUrl);
                const buffer = Buffer.from(await response.arrayBuffer());
                const base64Image = buffer.toString('base64');
                const mimeType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';

                const { systemPrompt } = composeConversationContext({
                    spaceId: buildTelegramSpaceId(chatId),
                    senderId,
                    channelRef: chatId,
                });

                const userPrompt = caption
                    ? `The user sent a photo with this caption: "${caption}". Analyze the image and answer helpfully and directly.`
                    : 'The user sent a photo without a caption. Describe what you see, infer what is relevant, and suggest the most useful next step.';

                const visionResponse = await processWithVision(systemPrompt, userPrompt, base64Image, mimeType);

                if (visionResponse.text) {
                    addSpanEvent('assistant.butler.photo_reply_sent', { response_chars: visionResponse.text.length });
                    await sendChannelMessage('telegram', chatId, visionResponse.text);

                    storeMessage({
                        id: `bot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                        space_id: buildTelegramSpaceId(chatId),
                        channel_ref: chatId,
                        sender_id: 'jivs',
                        content: visionResponse.text,
                        timestamp: new Date().toISOString(),
                        is_bot: 1,
                    });
                }
            } catch (err: any) {
                recordActiveSpanException(err, { 'app.butler.photo_status': 'failed' });
                logError('BUTLER', 'photo_processing_failed', summarizeError(err));
                await sendChannelMessage('telegram', chatId, 'Не удалось обработать фото. Попробуй ещё раз.');
            }
        }
    );
}
