import fs from 'node:fs';
import path from 'node:path';
import { isSafeContentId } from './content-id';

export type ContentScaffoldKind = 'pack' | 'grounding';

export type ContentScaffold = {
    kind: ContentScaffoldKind;
    id: string;
    files: Record<string, string>;
};

export type CreateContentScaffoldOptions = {
    projectRoot: string;
    kind: ContentScaffoldKind;
    id: string;
    dryRun?: boolean;
};

export type CreatedContentScaffold = {
    kind: ContentScaffoldKind;
    id: string;
    targetRoot: string;
    files: string[];
    dryRun: boolean;
};

function titleFromId(id: string): string {
    return id
        .split(/[_-]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function jsonDocument(meta: Record<string, unknown>, body: string): string {
    return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${body.trim()}\n`;
}

export function buildContentScaffold(kind: ContentScaffoldKind, id: string): ContentScaffold {
    if (!isSafeContentId(id)) {
        throw new Error(
            'Content ID must start with a letter or digit and contain only letters, digits, hyphens, or underscores.'
        );
    }

    const title = titleFromId(id);
    if (kind === 'pack') {
        return {
            kind,
            id,
            files: {
                'agent.md': jsonDocument(
                    {
                        id,
                        persona_id: id,
                        memory_rules: [],
                        default_policies: {},
                        authority_presets: {},
                        seeded_tasks: [],
                    },
                    `You are ${title}, a concise and dependable assistant.\n\nDescribe the pack's audience, tone, boundaries, and expected behavior here.`
                ),
                'skills.md': jsonDocument(
                    { enabled_capabilities: [], skill_hints: {} },
                    `# ${title} Skills\n\nAdd only the capabilities this pack genuinely needs, then explain how they should be used.`
                ),
            },
        };
    }

    return {
        kind,
        id,
        files: {
            'grounding.md': jsonDocument(
                {
                    id,
                    title,
                    description: `Stable context for ${title}.`,
                    default_language: null,
                    timezone: 'UTC',
                    memory_focus: [],
                    attention_bias: [],
                },
                `Describe the stable world, purpose, and context for ${title} here.`
            ),
            'people.md': `# People\n\nAdd stable people and roles only when they are genuinely useful.\n`,
            'operating.md': `# Operating Rules\n\nBe accurate, preserve uncertainty, and ask before high-impact actions.\n`,
            'glossary.md': `# Glossary\n\nAdd domain-specific terms and preferred meanings here.\n`,
        },
    };
}

export function createContentScaffold(options: CreateContentScaffoldOptions): CreatedContentScaffold {
    const scaffold = buildContentScaffold(options.kind, options.id);
    const parentName = options.kind === 'pack' ? 'packs' : 'groundings';
    const parentRoot = path.join(options.projectRoot, 'src', parentName);
    const targetRoot = path.join(parentRoot, options.id);
    const relativeFiles = Object.keys(scaffold.files).sort();

    if (fs.existsSync(targetRoot)) {
        throw new Error(`Refusing to overwrite existing ${options.kind} directory: ${targetRoot}`);
    }
    if (options.dryRun) {
        return { kind: options.kind, id: options.id, targetRoot, files: relativeFiles, dryRun: true };
    }

    fs.mkdirSync(parentRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(parentRoot, `.${options.id}.tmp-`));
    try {
        for (const [relativePath, content] of Object.entries(scaffold.files)) {
            fs.writeFileSync(path.join(temporaryRoot, relativePath), content, { flag: 'wx' });
        }
        fs.renameSync(temporaryRoot, targetRoot);
    } catch (error) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        throw error;
    }

    return { kind: options.kind, id: options.id, targetRoot, files: relativeFiles, dryRun: false };
}
