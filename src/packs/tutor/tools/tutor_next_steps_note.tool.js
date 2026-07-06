module.exports = {
    packTool: {
        id: 'tutor_next_steps_note',
        title: 'Tutor next steps note',
        description: 'Produce a short next-steps note for the current tutor space.',
        run(_args, runtime) {
            const steps = [];
            if (runtime.pending_counts.reminders > 0) {
                steps.push(`Review ${runtime.pending_counts.reminders} pending reminder(s) tied to study commitments.`);
            }
            if (runtime.pending_counts.todos > 0) {
                steps.push(`Pick the highest-value open learning task out of ${runtime.pending_counts.todos}.`);
            }
            if (runtime.active_tasks.length > 0) {
                steps.push(`Keep the next scheduled check-in in view: ${runtime.active_tasks[0].title}.`);
            }
            if (steps.length === 0) {
                steps.push('No urgent study loop surfaced; reinforce the last lesson and wait for the next concrete question.');
            }

            return [
                'Tutor next steps note',
                ...steps.slice(0, 3).map((step, index) => `${index + 1}. ${step}`),
            ].join('\n');
        },
    },
};
