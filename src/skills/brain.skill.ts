import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    appendNote,
    compileNotebook,
    promoteNoteToWiki,
    readWikiPage,
    searchNotes,
    updateWikiPage,
} from '../core/brain';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

function brainScope(context?: RuntimeExecutionContext): { spaceId?: string } {
    return { spaceId: resolveSpaceIdFromExecutionContext(context) };
}

function formatNoteLine(note: {
    id: string;
    topic: string;
    text: string;
    tags: string[];
    status: string;
    promoted_to: string | null;
}): string {
    const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
    const target = note.promoted_to ? ` -> ${note.promoted_to}` : '';
    const snippet = note.text.length > 180 ? `${note.text.substring(0, 180)}...` : note.text;
    return `- ${note.id} (${note.status}${target}) ${note.topic}${tags}: ${snippet}`;
}

const skill: SkillManifest = {
    name: 'brain',
    description:
        'Agent-maintained Brain Layer: notebook notes, curated wiki pages, playbook-ready knowledge, and search',
    version: '0.1.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'append_note',
            description:
                'Append a working notebook note. Use for observations, hypotheses, questions, rough decisions, and anything the agent wants to not forget before it becomes canonical knowledge.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    topic: { type: Type.STRING, description: 'Notebook topic, e.g. "pipi-os" or "dispatch".' },
                    text: { type: Type.STRING, description: 'The note body. Keep it specific and source-aware.' },
                    tags: {
                        type: Type.ARRAY,
                        description: 'Optional short tags such as memory, decision, question, hypothesis.',
                        items: { type: Type.STRING },
                    },
                },
                required: ['topic', 'text'],
            },
        },
        {
            name: 'search_notes',
            description: 'Search notebook notes by topic, text, tag, or note id.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Plain text query. Empty query returns recent notes.' },
                    limit: { type: Type.INTEGER, description: 'Maximum results, default 8, max 30.' },
                },
            },
        },
        {
            name: 'promote_note_to_wiki',
            description:
                'Promote a notebook note into a curated wiki page. This records provenance, appends a promoted note section, and marks the note as promoted. Use only when the note is ready to become canonical or reviewable wiki knowledge.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    note_id: {
                        type: Type.STRING,
                        description: 'The notebook note id returned by append_note/search_notes.',
                    },
                    target_page: {
                        type: Type.STRING,
                        description: 'Relative wiki page path, e.g. "projects/pipi-os.md" or "principles/memory.md".',
                    },
                },
                required: ['note_id', 'target_page'],
            },
        },
        {
            name: 'read_wiki_page',
            description: 'Read a curated wiki page from the Brain Layer.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    path: { type: Type.STRING, description: 'Relative wiki page path.' },
                },
                required: ['path'],
            },
        },
        {
            name: 'update_wiki_page',
            description:
                'Replace a wiki page with the complete revised Markdown body. JSON frontmatter is accepted and merged.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    path: { type: Type.STRING, description: 'Relative wiki page path.' },
                    body: {
                        type: Type.STRING,
                        description: 'Complete revised Markdown page body, optionally with JSON frontmatter.',
                    },
                },
                required: ['path', 'body'],
            },
        },
        {
            name: 'compile_notebook',
            description:
                'Compile a working notebook digest for a topic, grouped by note status. Use before deciding what should be promoted to wiki.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    topic: { type: Type.STRING, description: 'Topic to compile.' },
                    limit: { type: Type.INTEGER, description: 'Maximum notes to include, default 20, max 50.' },
                },
                required: ['topic'],
            },
        },
    ],
    handlers: {
        async append_note(args: { topic: string; text: string; tags?: string[] }, context?: RuntimeExecutionContext) {
            const note = appendNote({ topic: args.topic, text: args.text, tags: args.tags, ...brainScope(context) });
            return `[TOOL_RESULT] Notebook note appended: ${note.id}\nPath: ${note.file_path}\nTopic: ${note.topic}\nTags: ${note.tags.length > 0 ? note.tags.join(', ') : 'none'}`;
        },

        async search_notes(args: { query?: string; limit?: number }, context?: RuntimeExecutionContext) {
            const notes = searchNotes({ query: args.query, limit: args.limit, ...brainScope(context) });
            if (notes.length === 0) {
                return `[TOOL_RESULT] No notebook notes found${args.query ? ` for "${args.query}"` : ''}.`;
            }
            return `[TOOL_RESULT] Notebook notes:\n${notes.map(formatNoteLine).join('\n')}`;
        },

        async promote_note_to_wiki(args: { note_id: string; target_page: string }, context?: RuntimeExecutionContext) {
            const page = promoteNoteToWiki({
                note_id: args.note_id,
                target_page: args.target_page,
                ...brainScope(context),
            });
            return `[TOOL_RESULT] Note ${args.note_id} promoted to wiki page ${page.path}.\nPath: ${page.file_path}`;
        },

        async read_wiki_page(args: { path: string }, context?: RuntimeExecutionContext) {
            const page = readWikiPage(args.path, brainScope(context));
            if (!page.exists) {
                return `[TOOL_RESULT] Wiki page not found: ${page.path}\nPath: ${page.file_path}`;
            }
            return `[TOOL_RESULT] Wiki page ${page.path}:\n${page.content}`;
        },

        async update_wiki_page(args: { path: string; body: string }, context?: RuntimeExecutionContext) {
            const page = updateWikiPage({ path: args.path, body: args.body, ...brainScope(context) });
            return `[TOOL_RESULT] Wiki page updated: ${page.path}\nPath: ${page.file_path}`;
        },

        async compile_notebook(args: { topic: string; limit?: number }, context?: RuntimeExecutionContext) {
            return `[TOOL_RESULT] ${compileNotebook({ topic: args.topic, limit: args.limit, ...brainScope(context) })}`;
        },
    },
};

export default skill;
