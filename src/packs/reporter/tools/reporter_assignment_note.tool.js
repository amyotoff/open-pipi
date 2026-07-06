module.exports = {
    packTool: {
        id: 'reporter_assignment_note',
        title: 'Reporter assignment note',
        description: 'Produce a short assignment-style note for the current reporter space.',
        run(_args, runtime) {
            const visibleTasks = runtime.active_tasks
                .slice(0, 3)
                .map((task) => `- ${task.title} (${task.schedule_value})`)
                .join('\n');

            return [
                'Reporter assignment note',
                `Participants in scope: ${runtime.participant_count}`,
                `Current memory sprint: ${runtime.memory_sprint.opened_at.substring(0, 10)} -> ${runtime.memory_sprint.closes_at.substring(0, 10)}`,
                visibleTasks ? `Scheduled editorial cadence:\n${visibleTasks}` : 'Scheduled editorial cadence: nothing notable yet',
                'Assignment reflection: tighten the brief until the next reporting move is obvious and sourceable.',
            ].join('\n');
        },
    },
};
