module.exports = {
    packTool: {
        id: 'office_focus_note',
        title: 'Office focus note',
        description: 'Summarize the current office space into a compact operational focus note.',
        run(_args, runtime) {
            const actions = [];

            if (runtime.pending_counts.reminders > 0) {
                actions.push(`${runtime.pending_counts.reminders} reminder(s) are pending and should be checked first.`);
            }
            if (runtime.pending_counts.todos > 0) {
                actions.push(`${runtime.pending_counts.todos} todo(s) remain open and likely need owners or sequencing.`);
            }
            if (actions.length === 0 && runtime.active_tasks.length > 0) {
                actions.push(`Scheduled coordination is already in place through ${runtime.active_tasks.length} active task(s).`);
            }
            if (actions.length === 0) {
                actions.push('No obvious operational pressure surfaced from the current snapshot.');
            }

            return [
                'Office focus note',
                `Participants: ${runtime.participant_count}`,
                `Active tasks: ${runtime.active_task_count}`,
                ...actions.slice(0, 3).map((item, index) => `${index + 1}. ${item}`),
            ].join('\n');
        },
    },
};
