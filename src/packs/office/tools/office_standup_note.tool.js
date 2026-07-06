module.exports = {
    packTool: {
        id: 'office_standup_note',
        title: 'Office standup note',
        description: 'Produce a short standup-style note for the current office space.',
        run(_args, runtime) {
            const participantLine = runtime.participant_names.length > 0
                ? runtime.participant_names.slice(0, 5).join(', ')
                : 'No named participants found';

            const visibleTasks = runtime.active_tasks
                .slice(0, 3)
                .map((task) => `- ${task.title} (${task.schedule_value})`)
                .join('\n');

            return [
                'Office standup note',
                `People in scope: ${participantLine}`,
                `Open loops: ${runtime.pending_counts.todos} todos, ${runtime.pending_counts.reminders} reminders`,
                visibleTasks ? `Scheduled coordination:\n${visibleTasks}` : 'Scheduled coordination: nothing notable yet',
                'Reflection: keep the thread short, assign owners clearly, and close ambiguity before it compounds.',
            ].join('\n');
        },
    },
};
