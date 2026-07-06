module.exports = {
    packTool: {
        id: 'jeeves_brief_note',
        title: 'Jeeves brief note',
        description: 'Generate a compact personal briefing for the current Jeeves space.',
        run(_args, runtime) {
            const sprint = `${runtime.memory_sprint.opened_at.substring(0, 10)} -> ${runtime.memory_sprint.closes_at.substring(0, 10)}`;
            const workspace = runtime.workspace_path || 'none';
            return [
                'Jeeves brief',
                `Space: ${runtime.space_id}`,
                `Participants: ${runtime.participant_count}`,
                `Pending: ${runtime.pending_counts.todos} todos, ${runtime.pending_counts.reminders} reminders`,
                `Active tasks: ${runtime.active_task_count}`,
                `Memory sprint: ${sprint} (${runtime.memory_sprint.cadence_days} days)`,
                `Workspace: ${workspace}`,
            ].join('\n');
        },
    },
};
