import fs from 'fs';
import path from 'path';
import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

const REPO_ROOT = path.resolve(__dirname, '../..');
const HELP_PATH = path.join(REPO_ROOT, 'help.md');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const README_MAX_CHARS = 60000;
const MAX_REFERENCE_CHARS = 9000;

type FileCacheEntry = { mtimeMs: number; content: string };
const fileCache = new Map<string, FileCacheEntry>();

function readFileCached(filePath: string, maxChars?: number): string | null {
    try {
        const stat = fs.statSync(filePath);
        const cached = fileCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.content;
        }
        let content = fs.readFileSync(filePath, 'utf-8');
        if (maxChars && content.length > maxChars) {
            content = content.slice(0, maxChars) + '\n\n[... truncated, see full file on disk]';
        }
        fileCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
        return content;
    } catch {
        return null;
    }
}

function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .split(/[^a-zа-яё0-9_/-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);
}

function expandTopicTokens(topic: string): string[] {
    const tokens = new Set(tokenize(topic));
    const lower = topic.toLowerCase();

    const expansions: Array<[RegExp, string[]]> = [
        [/(help|справ|помощ|умеешь|можешь|can you|what can)/i, ['help', 'common', 'questions', 'operator']],
        [/(setup|start|старт|настро|онборд)/i, ['setup', 'bootstrap', 'quickstart', 'onboarding']],
        [/(pack|persona|personality|личност|голос)/i, ['pack', 'packs', 'mutate', 'personality']],
        [/(grounding|контекст|world|правил)/i, ['grounding', 'overrides', 'world', 'rules']],
        [/(memory|памят|remember|запомн)/i, ['memory', 'diary', 'insights', 'recall']],
        [/(backup|restore|бэкап|резерв)/i, ['backup', 'restore', 'restore-point']],
        [/(channel|канал|mode|режим)/i, ['channel', 'mode', 'notify_only', 'inbox']],
        [/(cost|budget|token|spend|стоим|бюджет)/i, ['budget', 'spend', 'token', 'cost']],
        [/(artifact|html|page|страниц|документ)/i, ['artifact', 'html', 'page', 'shareable']],
    ];

    for (const [pattern, words] of expansions) {
        if (pattern.test(lower)) {
            for (const word of words) tokens.add(word);
        }
    }

    return [...tokens];
}

type MarkdownSection = {
    source: string;
    title: string;
    text: string;
    score: number;
};

function splitMarkdownSections(source: string, content: string): MarkdownSection[] {
    const sections: MarkdownSection[] = [];
    const lines = content.split(/\r?\n/);
    let currentTitle = source;
    let currentLines: string[] = [];

    const flush = () => {
        const text = currentLines.join('\n').trim();
        if (!text) return;
        sections.push({ source, title: currentTitle, text, score: 0 });
    };

    for (const line of lines) {
        const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
        if (heading) {
            flush();
            currentTitle = heading[2].trim();
            currentLines = [line];
            continue;
        }
        currentLines.push(line);
    }

    flush();
    return sections;
}

function scoreSection(section: MarkdownSection, topicTokens: string[]): number {
    const haystack = `${section.title}\n${section.text}`.toLowerCase();
    const title = section.title.toLowerCase();
    let score = section.source === 'help.md' ? 2 : 0;

    for (const token of topicTokens) {
        if (title.includes(token)) score += 8;
        if (haystack.includes(token)) score += 2;
    }

    if (/common user questions|when to call|operator commands/i.test(section.title)) score += 2;
    return score;
}

function buildHelpReference(topic?: string): string {
    const normalizedTopic = String(topic || '').trim();
    const topicTokens = expandTopicTokens(normalizedTopic || 'help capabilities commands setup packs');
    const help = readFileCached(HELP_PATH);
    const readme = readFileCached(README_PATH, README_MAX_CHARS);
    const sections: MarkdownSection[] = [];

    if (help) sections.push(...splitMarkdownSections('help.md', help));
    if (readme) sections.push(...splitMarkdownSections('README.md', readme));

    const ranked = sections
        .map((section) => ({ ...section, score: scoreSection(section, topicTokens) }))
        .filter((section) => section.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 6);

    const selected = ranked.length > 0 ? ranked : sections.slice(0, 4);
    const lines = [
        '[TOOL_RESULT] Help reference',
        `Topic: ${normalizedTopic || 'general help'}`,
        '',
        'Use these excerpts to answer the user naturally. Prefer the user language. Do not paste raw excerpts unless asked.',
    ];

    if (selected.length === 0) {
        lines.push('', 'No local help files were found.');
        return lines.join('\n');
    }

    let used = lines.join('\n').length;
    for (const section of selected) {
        const block = ['', `--- ${section.source}: ${section.title} ---`, section.text.trim()].join('\n');
        if (used + block.length > MAX_REFERENCE_CHARS) {
            const remaining = MAX_REFERENCE_CHARS - used - 80;
            if (remaining > 500) {
                lines.push(
                    '',
                    `--- ${section.source}: ${section.title} ---`,
                    `${section.text.trim().slice(0, remaining)}\n[truncated]`
                );
            }
            break;
        }
        lines.push(block);
        used += block.length;
    }

    return lines.join('\n');
}

const skill: SkillManifest = {
    name: 'helper',
    description:
        'Self-documenting helper: lookup operator/user guidance from help.md and README.md to answer meta questions about the bot',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'helper_lookup',
            description:
                'Search the bot\'s own help.md and README.md for relevant excerpts to answer user questions about how the bot works, what it can do, what commands mean, or how to operate it. Call when the user asks "how do I...", "what can you do", "what is X", "как это работает", "что ты умеешь", or any meta-question about the bot itself — NOT for ordinary task requests (shopping, reminders, etc.). After calling, answer in natural language; do not paste the raw excerpts.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    topic: {
                        type: Type.STRING,
                        description:
                            'Optional short phrase describing what the user is asking about (e.g. "packs", "backups", "channel modes"). Used to rank README/help sections.',
                    },
                },
            },
        },
        {
            name: 'help_lookup',
            description:
                'Help tool for system/product support questions. Search README.md and help.md for the best local guidance before answering questions like "help", "how do I use you", "what can you do", "как пользоваться", "что ты умеешь", setup, packs, grounding, memory, channel modes, backups, or budget. Do not call for ordinary task execution.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    topic: {
                        type: Type.STRING,
                        description: 'Short phrase naming the help topic to search for.',
                    },
                },
            },
        },
    ],
    handlers: {
        async helper_lookup(args: { topic?: string }, _context?: ExecutionContext) {
            return buildHelpReference(args.topic);
        },

        async help_lookup(args: { topic?: string }, _context?: ExecutionContext) {
            return buildHelpReference(args.topic);
        },
    },
};

export default skill;
