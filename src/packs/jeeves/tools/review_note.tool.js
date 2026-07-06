module.exports = {
    packTool: {
        id: 'jeeves_review_note',
        title: 'Jeeves review note',
        description: 'Produce a short end-of-day review note for the current Jeeves space.',
        run(_args, runtime) {
            const outstanding = runtime.active_tasks
                .slice(0, 3)
                .map((task) => `- ${task.title}`)
                .join('\n');

            return [
                'Jeeves review',
                runtime.active_task_count > 0
                    ? `Still in motion: ${runtime.active_task_count} scheduled item(s).`
                    : 'The day appears fairly quiet from the current task slate.',
                `Open loops: ${runtime.pending_counts.todos} todos, ${runtime.pending_counts.reminders} reminders.`,
                outstanding ? `Most visible scheduled items:\n${outstanding}` : 'No scheduled items stand out right now.',
                'Reflection: keep tomorrow pointed at the smallest useful next step, not the whole mountain.',
            ].join('\n');
        },
    },
};
