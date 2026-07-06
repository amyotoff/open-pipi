module.exports = {
    packTool: {
        id: 'reporter_topic_note',
        title: 'Reporter topic note',
        description: 'Summarize the current reporter space into a concise editorial topic note.',
        run(_args, runtime) {
            const lines = [
                'Reporter topic note',
                `Open loops: ${runtime.pending_counts.todos} todos, ${runtime.pending_counts.reminders} reminders`,
                `Scheduled editorial tasks: ${runtime.active_task_count}`,
            ];

            if (runtime.workspace_path) {
                lines.push(`Workspace attached: ${runtime.workspace_path}`);
            } else {
                lines.push('Workspace attached: none');
            }

            if (runtime.active_tasks.length > 0) {
                lines.push(`Most visible scheduled lead: ${runtime.active_tasks[0].title}`);
            } else {
                lines.push('No scheduled lead stands out yet.');
            }

            lines.push('Editorial reflection: pursue the angle with the clearest sourcing path, not the noisiest one.');
            return lines.join('\n');
        },
    },
};
