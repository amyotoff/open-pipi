type TelegramFormattedText = {
    html: string;
    plain: string;
};

const TOP_LEVEL_BULLET = '•';
const NESTED_BULLET = '◦';
const DEEP_BULLET = '▪';

function escapeTelegramHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatInlineHtml(text: string): string {
    return text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
}

function formatInlinePlain(text: string): string {
    return text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
}

function formatListLine(line: string): string | null {
    const match = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (!match) return null;

    const indentWidth = match[1].replace(/\t/g, '    ').length;
    const depth = Math.min(Math.floor(indentWidth / 2), 2);
    const bullet = depth === 0 ? TOP_LEVEL_BULLET : depth === 1 ? NESTED_BULLET : DEEP_BULLET;

    return `${'  '.repeat(depth)}${bullet} ${match[2]}`;
}

function normalizeListMarkers(text: string): string {
    return text
        .split('\n')
        .map((line) => formatListLine(line) ?? line)
        .join('\n');
}

export function formatTelegramText(text: string): TelegramFormattedText {
    const normalized = normalizeListMarkers(text);
    const html = normalized
        .split('\n')
        .map((line) => formatInlineHtml(escapeTelegramHtml(line)))
        .join('\n');
    const plain = normalized.split('\n').map(formatInlinePlain).join('\n');

    return { html, plain };
}
