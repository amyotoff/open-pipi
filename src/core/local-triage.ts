import { PIPI_LOCAL_ROUTING_ENABLED } from '../config';
import { classifyWithOllama } from './ollama';

export type MessageRoute = 'simple' | 'complex';

const OBVIOUS_SIMPLE_PATTERNS = [
    /^(привет|здравствуй|хай|хей|добр(ое|ый|ой)|салют|здоров|йо|hello|hi|hey)(?:$|[\s.!?,])/i,
    /^(спасибо|благодар|мерси|thx|thanks|спс|пасиб)(?:$|[\s.!?,])/i,
    /^(ок|окей|ладно|понял|ясно|хорошо|отлично|супер|класс|круто|ага|угу|да|нет|не надо|не нужно|ну ок|got it|okay)\s*[.!]?$/i,
    /^(пока|спокойной|до завтра|good night|доброй ночи|сладких снов|bye)(?:$|[\s.!?,])/i,
    /^(который час|сколько время|какой день|какое число|what time is it)\s*\??$/i,
    /^(как дела|что нового|как ты|how are you)\s*\??$/i,
];

const DEFINITELY_COMPLEX_PATTERN =
    /(https?:\/\/|найди|поищи|исследуй|research|search|сравни|compare|проанализ|analy[sz]e|создай|create|запиши|remember|запомни|напомни|remind|schedule|удали|delete|отправь|send|позвони|call|забронируй|book|купи|buy|обнови|update|файл|document|документ|таблиц|spreadsheet|почт|email|crm|calendar|календар|home\s*assistant|умн(?:ый|ого|ом)\s+дом|включи|выключи|зажги|погаси|яркост|ламп|turn\s+(?:on|off)|brightness)/i;

export function isObviouslySimpleMessage(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    return OBVIOUS_SIMPLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export async function classifyMessageRoute(text: string): Promise<{ route: MessageRoute; source: string }> {
    if (isObviouslySimpleMessage(text)) return { route: 'simple', source: 'rule_simple' };
    if (DEFINITELY_COMPLEX_PATTERN.test(text)) return { route: 'complex', source: 'rule_complex' };
    if (!PIPI_LOCAL_ROUTING_ENABLED) return { route: 'complex', source: 'disabled' };

    const answer = await classifyWithOllama(
        [
            'Classify the user message for an assistant router.',
            'Return exactly SIMPLE only for casual conversation answerable without tools, current facts, private memory, planning, or multi-step reasoning.',
            'Return exactly COMPLEX for everything else. When uncertain return COMPLEX.',
            `<message>${text.slice(0, 1200)}</message>`,
        ].join('\n')
    );
    return /^simple\b/i.test(answer || '')
        ? { route: 'simple', source: 'ollama' }
        : { route: 'complex', source: answer ? 'ollama' : 'safe_fallback' };
}

export async function shouldJoinGroupConversation(text: string): Promise<boolean> {
    if (!PIPI_LOCAL_ROUTING_ENABLED) return false;
    const answer = await classifyWithOllama(
        [
            'Decide whether a quiet assistant should join this group conversation without being addressed.',
            'Return exactly YES only if the assistant can add concrete, timely value or correct a consequential mistake.',
            'Return NO for acknowledgements, banter, generic questions, repetition, or merely staying visible.',
            `<latest_message>${text.slice(0, 1200)}</latest_message>`,
        ].join('\n')
    );
    return /^yes\b/i.test(answer || '');
}
