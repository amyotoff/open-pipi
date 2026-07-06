function splitItems(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }

    return String(value || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);
}

function formatColumn(title, items) {
    const lines = items.length > 0 ? items.map((item) => `- ${item}`) : ['- Add the first task'];
    return [`## ${title}`, ...lines].join('\n');
}

module.exports = {
    packTool: {
        id: 'office_kanban_board',
        title: 'Office kanban board',
        description: 'Draft a simple three-column kanban board body for publishing as a shareable HTML artifact.',
        parameters: {
            type: 'OBJECT',
            properties: {
                title: { type: 'STRING', description: 'Board title.' },
                todo: { type: 'STRING', description: 'To-do items, one per line.' },
                doing: { type: 'STRING', description: 'In-progress items, one per line.' },
                done: { type: 'STRING', description: 'Done items, one per line.' },
            },
        },
        run(args, runtime) {
            const title = String(args.title || 'Team Kanban Board').trim();
            const todo = splitItems(args.todo);
            const doing = splitItems(args.doing);
            const done = splitItems(args.done);

            if (todo.length === 0 && doing.length === 0 && done.length === 0) {
                todo.push(...runtime.active_tasks.slice(0, 8).map((task) => task.title));
            }

            const body = [
                formatColumn('To do', todo),
                formatColumn('In progress', doing),
                formatColumn('Done', done),
            ].join('\n\n');

            return [
                'Office kanban board draft',
                `Title: ${title}`,
                'Publish: call html_artifact_create with kind "kanban_board", this title, and the board body below. Regenerate the shared page when team-visible statuses change.',
                '',
                body,
            ].join('\n');
        },
    },
};
