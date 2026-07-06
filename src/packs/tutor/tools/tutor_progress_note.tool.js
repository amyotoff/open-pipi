module.exports = {
    packTool: {
        id: 'tutor_progress_note',
        title: 'Tutor progress note',
        description: 'Summarize the current tutor space into a compact learning progress note.',
        run(_args, runtime) {
            return [
                'Tutor progress note',
                `Learners in scope: ${runtime.participant_count}`,
                `Open learning loops: ${runtime.pending_counts.todos} todos, ${runtime.pending_counts.reminders} reminders`,
                `Scheduled study tasks: ${runtime.active_task_count}`,
                `Current sprint length: ${runtime.memory_sprint.cadence_days} days`,
                'Learning reflection: reinforce what is already half-understood before adding new cognitive load.',
            ].join('\n');
        },
    },
};
