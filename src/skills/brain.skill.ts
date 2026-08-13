import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { appendNote, compileNotebook, promoteNoteToWiki, searchNotes, updateWikiPage } from '../core/brain';
import { readWikiPageForReader, updateWikiPage as writeWikiPage } from '../core/brain-wiki';
import { sharedScope } from '../core/brain-store';
import { captureRawSource, captureSharedDocuments, listRawSources, RawSourceState } from '../core/brain-ingest';
import { answerFromWiki, archiveAnswer, searchWiki } from '../core/brain-query';
import { formatLintDigest, isLintDue, lintWiki } from '../core/brain-lint';
import { getBrainSchema, readBrainTemplate } from '../core/brain-schema';
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
        'Agent-maintained knowledge wiki: capture sources, compile them into pages, answer from them with citations, and keep the whole thing linted',
    version: '0.2.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    toolMeta: {
        wiki_save: {
            approval: 'explicit',
            approval_action: 'wiki_save',
            approval_reason: 'Writes a page into the wiki everyone in this install can read.',
            approval_detail_fields: ['path', 'preview'],
        },
        wiki_capture_documents: {
            approval: 'explicit',
            approval_action: 'wiki_capture_documents',
            approval_reason: 'Files these documents into the shared wiki for compilation.',
            approval_detail_fields: ['count', 'titles'],
        },
        wiki_archive: {
            approval: 'explicit',
            approval_action: 'wiki_archive',
            approval_reason: 'Files this answer into the wiki everyone in this install can read.',
            approval_detail_fields: ['title'],
        },
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
                "Replace one of THIS CHAT's own wiki pages with the complete revised Markdown body. Chat-local: the result is not visible in other chats, and it refuses if the page lives in the shared wiki — use wiki_save for those. JSON frontmatter is accepted and merged.",
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
            name: 'brain_capture',
            description:
                "Capture a source into THIS CHAT's own raw/ collection and queue it for compilation. Chat-local: use it when you are filing something on your own initiative. When the owner asks to keep a document, use wiki_capture_documents so it reaches the shared wiki instead.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Source title, taken from the source itself.' },
                    content: {
                        type: Type.STRING,
                        description:
                            'The source text, preserved faithfully. Clean formatting noise but never rewrite opinions or alter meaning.',
                    },
                    topic: {
                        type: Type.STRING,
                        description:
                            'Topic directory under raw/, e.g. "health" or "ai-tools". Reuse an existing topic unless the source is genuinely distinct.',
                    },
                    url: { type: Type.STRING, description: 'Origin URL when the source came from the web.' },
                    published_at: {
                        type: Type.STRING,
                        description: 'Publication date as YYYY-MM-DD when the source states one.',
                    },
                },
                required: ['title', 'content'],
            },
        },
        {
            name: 'list_raw_sources',
            description:
                'List captured sources and their queue state (queued, triaged, compiled, no_material, failed). Use to report the ingest backlog.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    state: {
                        type: Type.STRING,
                        description: 'Optional state filter: queued, triaged, compiled, no_material, or failed.',
                    },
                    limit: { type: Type.INTEGER, description: 'Maximum results, default 20, max 200.' },
                },
            },
        },
        {
            name: 'wiki_save',
            description:
                'Save a page into the shared wiki — the one wiki this whole install reads. Use when the owner asks to remember something in the wiki, and propose it yourself when a conversation produces knowledge worth keeping; the owner confirms before anything is written. For notes that are not ready to be canonical, use append_note instead.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    path: {
                        type: Type.STRING,
                        description: 'Relative page path with one topic level, e.g. "people/anna.md".',
                    },
                    title: { type: Type.STRING, description: 'Page title.' },
                    body: {
                        type: Type.STRING,
                        description: 'The complete page as Markdown, starting with a # heading.',
                    },
                },
                required: ['path', 'body'],
            },
        },
        {
            name: 'wiki_capture_documents',
            description:
                'File one or more already-converted documents into the shared wiki for compilation. Use for a single document the owner hands over as well as for bulk intake — a folder of notes, an exported archive, or text extracted from PDFs elsewhere. One confirmation covers the whole batch.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    documents: {
                        type: Type.ARRAY,
                        description: 'The documents, each already converted to plain text or Markdown.',
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING, description: 'Document title.' },
                                content: { type: Type.STRING, description: 'The document text.' },
                                topic: { type: Type.STRING, description: 'Topic directory under raw/.' },
                                url: { type: Type.STRING, description: 'Origin URL, when there is one.' },
                            },
                            required: ['title', 'content'],
                        },
                    },
                },
                required: ['documents'],
            },
        },
        {
            name: 'wiki_search',
            description:
                'Search compiled wiki pages by topic or keyword. Returns page paths with one-line summaries. Use before answering anything the wiki might already know, and read a page with read_wiki_page before relying on it.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Search terms, including likely synonyms.' },
                    limit: { type: Type.INTEGER, description: 'Maximum results, default 8, max 50.' },
                },
                required: ['query'],
            },
        },
        {
            name: 'wiki_answer',
            description:
                'Answer a question from the wiki and cite the pages used. Use for "what do I know about X", "summarise everything on Y", or comparisons across compiled pages. This never writes files.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    question: { type: Type.STRING, description: "The question, in the owner's own words." },
                },
                required: ['question'],
            },
        },
        {
            name: 'wiki_archive',
            description:
                'File a good answer back into the wiki as an archive page, so an exploration compounds instead of disappearing into chat history. Only use when the owner explicitly asks to save or archive the answer.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Title of the archived answer.' },
                    body: { type: Type.STRING, description: 'The answer as markdown.' },
                    topic: { type: Type.STRING, description: 'Topic directory, e.g. "health". Defaults to "archive".' },
                    citations: {
                        type: Type.ARRAY,
                        description: 'Wiki page paths the answer was built from, e.g. ["people/anna.md"].',
                        items: { type: Type.STRING },
                    },
                },
                required: ['title', 'body'],
            },
        },
        {
            name: 'wiki_schema',
            description:
                'Read the schema layer: the rules this wiki is maintained by, and optionally a page template. Read it when the exact page format matters or the owner asks how the wiki works.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    template: {
                        type: Type.STRING,
                        description: 'Optional template to include: "article", "archive", or "raw".',
                    },
                },
            },
        },
        {
            name: 'wiki_lint',
            description:
                'Health-check the wiki: repair index entries and broken links, verify that claims are grounded in the linked raw sources, and report contradictions, orphans, and stale archives. Safe repairs are applied; facts are only reported.',
            parameters: {
                type: Type.OBJECT,
                properties: {},
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
    crons: [
        {
            expression: '*/30 * * * *',
            description: 'Drain the wiki ingest queue',
            handler: async () => {
                const { listSpaces } = await import('../db');
                const { runIngestQueue } = await import('../core/brain-ingest');

                // The shared wiki is drained once for the whole install; spaces are visited only
                // for sources filed before the wiki became shared.
                for (const scope of [
                    { shared: true },
                    ...listSpaces('ACTIVE').map((space) => ({ spaceId: space.id })),
                ]) {
                    const result = await runIngestQueue({ ...scope, limit: 3 });
                    // A budget block is not an error: the source stays queued for tomorrow.
                    if (result.blocked) break;
                }
            },
        },
        {
            expression: '20 4 * * *',
            description: 'Wiki lint on the memory-sprint cadence',
            handler: async () => {
                const { listSpaces } = await import('../db');
                const { resolveMemorySprintDays } = await import('../core/memory-sprint');
                const { rememberWorkMemory } = await import('../core/memory-write');

                const spaces = listSpaces('ACTIVE');
                // The shared wiki is linted once, on the shortest cadence any space asks for.
                const sharedCadence = Math.min(...spaces.map((space) => resolveMemorySprintDays(space.id)), 7);
                if (isLintDue({ shared: true }, sharedCadence)) {
                    const report = await lintWiki({ shared: true });
                    // The digest rides the sprint report the owner already reads (D10). The
                    // shared wiki belongs to every space, so its health is reported in each.
                    for (const space of report.issues > 0 ? spaces : []) {
                        rememberWorkMemory(space.id, 'wiki_lint', formatLintDigest(report), {
                            salience: 0.5,
                            source: 'wiki_lint_cron',
                        });
                    }
                }

                for (const space of spaces) {
                    const scope = { spaceId: space.id };
                    const cadenceDays = resolveMemorySprintDays(space.id);
                    if (!isLintDue(scope, cadenceDays)) continue;

                    const report = await lintWiki(scope);
                    if (report.issues === 0) continue;
                    rememberWorkMemory(space.id, 'wiki_lint', formatLintDigest(report), {
                        salience: 0.5,
                        source: 'wiki_lint_cron',
                    });
                }
            },
        },
    ],

    preflight: {
        // Approval shows arguments, so what the owner needs to judge has to be an argument.
        wiki_save: (args: { path?: string; body?: string }) => ({
            ...args,
            preview: String(args.body || '')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 160),
        }),
        wiki_capture_documents: (args: { documents?: Array<{ title?: string }> }) => {
            const documents = Array.isArray(args.documents) ? args.documents : [];
            return {
                ...args,
                count: documents.length,
                titles: documents
                    .slice(0, 5)
                    .map((document) => document.title || 'untitled')
                    .join(', '),
            };
        },
    },

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
            const page = await promoteNoteToWiki({
                note_id: args.note_id,
                target_page: args.target_page,
                ...brainScope(context),
            });
            const note = page.compiled
                ? 'The note was compiled into the page.'
                : 'No model was available, so the note was filed verbatim and the page is marked needs_review.';
            return `[TOOL_RESULT] Note ${args.note_id} promoted to wiki page ${page.path}.\nPath: ${page.file_path}\n${note}`;
        },

        async read_wiki_page(args: { path: string }, context?: RuntimeExecutionContext) {
            const page = readWikiPageForReader({
                path: args.path,
                ...brainScope(context),
                personId: context?.userId,
            });
            if (!page.allowed) {
                return `[TOOL_RESULT] ${page.path} is an owner-only page and is not readable here.`;
            }
            if (!page.exists) {
                return `[TOOL_RESULT] Wiki page not found: ${page.path}\nPath: ${page.file_path}`;
            }
            return `[TOOL_RESULT] Wiki page ${page.path}:\n${page.content}`;
        },

        async update_wiki_page(args: { path: string; body: string }, context?: RuntimeExecutionContext) {
            const page = updateWikiPage({ path: args.path, body: args.body, ...brainScope(context) });
            return `[TOOL_RESULT] Wiki page updated: ${page.path}\nPath: ${page.file_path}`;
        },

        async brain_capture(
            args: { title: string; content: string; topic?: string; url?: string; published_at?: string },
            context?: RuntimeExecutionContext
        ) {
            const result = captureRawSource({ ...args, ...brainScope(context) });
            if (result.duplicate) {
                return `[TOOL_RESULT] This source is already in raw/ (identical content): ${result.source.path}\nState: ${result.source.state}. Nothing was written.`;
            }
            return `[TOOL_RESULT] Source captured: ${result.source.title}\nPath: ${result.file_path}\nTopic: ${result.source.topic}\nState: ${result.source.state} — compilation runs as a background job.`;
        },

        async list_raw_sources(args: { state?: string; limit?: number }, context?: RuntimeExecutionContext) {
            const sources = listRawSources({
                state: args.state as RawSourceState | undefined,
                limit: args.limit,
                ...brainScope(context),
            });
            if (sources.length === 0) {
                return `[TOOL_RESULT] No captured sources${args.state ? ` in state "${args.state}"` : ''}.`;
            }
            const lines = sources.map(
                (source) =>
                    `- ${source.path} (${source.state}${source.disposition ? `: ${source.disposition}` : ''}) ${source.title}`
            );
            return `[TOOL_RESULT] Captured sources:\n${lines.join('\n')}`;
        },

        async wiki_save(args: { path: string; title?: string; body: string }, context?: RuntimeExecutionContext) {
            const scope = sharedScope(brainScope(context));
            const page = writeWikiPage({ ...scope, path: args.path, body: args.body });
            return `[TOOL_RESULT] Saved to the shared wiki: ${page.path}\nPath: ${page.file_path}\nEveryone in this install can read it.`;
        },

        async wiki_capture_documents(
            args: { documents: Array<{ title: string; content: string; topic?: string; url?: string }> },
            context?: RuntimeExecutionContext
        ) {
            const result = captureSharedDocuments({ documents: args.documents || [], ...brainScope(context) });
            const lines = [
                `Filed ${result.captured.length} document(s) into the shared wiki.`,
                result.duplicates > 0 ? `${result.duplicates} were already there and were skipped.` : '',
                result.failed.length > 0
                    ? `${result.failed.length} could not be filed: ${result.failed.map((entry) => `${entry.title} (${entry.reason})`).join('; ')}`
                    : '',
                'Compilation into pages runs as a background job.',
            ].filter(Boolean);
            return `[TOOL_RESULT] ${lines.join('\n')}`;
        },

        async wiki_search(args: { query: string; limit?: number }, context?: RuntimeExecutionContext) {
            const hits = searchWiki({
                query: args.query,
                limit: args.limit,
                personId: context?.userId,
                ...brainScope(context),
            });
            if (hits.length === 0) {
                return `[TOOL_RESULT] Searched the wiki index and full text for "${args.query}" and found no page.`;
            }
            const lines = hits.map(
                (hit) =>
                    `- ${hit.path}${hit.origin === 'space' ? ' [this chat only]' : ''} — ${hit.title}: ${hit.excerpt.substring(0, 160)} (${hit.knowledge_updated_at})`
            );
            return `[TOOL_RESULT] Wiki pages for "${args.query}":\n${lines.join('\n')}`;
        },

        async wiki_answer(args: { question: string }, context?: RuntimeExecutionContext) {
            const answer = await answerFromWiki({
                question: args.question,
                personId: context?.userId,
                ...brainScope(context),
            });
            const citations = answer.citations.length > 0 ? `\nCited: ${answer.citations.join(', ')}` : '';
            return `[TOOL_RESULT] ${answer.text}${citations}`;
        },

        async wiki_archive(
            args: { title: string; body: string; topic?: string; citations?: string[] },
            context?: RuntimeExecutionContext
        ) {
            const page = await archiveAnswer({ ...args, ...brainScope(context) });
            return `[TOOL_RESULT] Answer archived as ${page.path}.\nPath: ${page.file_path}`;
        },

        async wiki_schema(args: { template?: string }) {
            // The shared wiki compiles without a chat attached, so the shipped schema is the
            // one actually in force. Showing a per-chat override here would be a fiction.
            const schema = getBrainSchema();
            const name = args.template as 'article' | 'archive' | 'raw' | undefined;
            const template = name ? readBrainTemplate(name) : '';
            const suffix = name
                ? template
                    ? `\n\n--- ${name} template ---\n${template}`
                    : `\n\n(no template named "${name}")`
                : '';
            return `[TOOL_RESULT] Schema in force for the shared wiki:\n${schema}${suffix}`;
        },

        async wiki_lint(_args: Record<string, never>, context?: RuntimeExecutionContext) {
            // The shared wiki is the one everyone reads, so it is the one a manual lint means.
            const report = await lintWiki(sharedScope(brainScope(context)));
            return `[TOOL_RESULT] Shared wiki — ${formatLintDigest(report)}`;
        },

        async compile_notebook(args: { topic: string; limit?: number }, context?: RuntimeExecutionContext) {
            return `[TOOL_RESULT] ${compileNotebook({ topic: args.topic, limit: args.limit, ...brainScope(context) })}`;
        },
    },
};

export default skill;
