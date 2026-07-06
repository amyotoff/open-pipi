module.exports = {
    packTool: {
        id: 'jeeves_focus_plan',
        title: 'Jeeves focus plan',
        description: 'Extract the 1-3 most useful next actions for the current Jeeves space.',
        run(_args, runtime) {
            const actions = [];

            if (runtime.pending_counts.reminders > 0) {
                actions.push(`Review ${runtime.pending_counts.reminders} pending reminder(s) and act on the closest one.`);
            }
            if (runtime.pending_counts.todos > 0) {
                actions.push(`Clear the highest-value todo from the ${runtime.pending_counts.todos} still pending.`);
            }
            if (actions.length === 0 && runtime.active_tasks.length > 0) {
                const nextTask = runtime.active_tasks[0];
                actions.push(`Keep ${nextTask.title} in view; it is already scheduled for ${nextTask.schedule_value}.`);
            }
            if (actions.length === 0) {
                actions.push('No obvious loose ends surfaced; keep the day calm and only respond to new, concrete needs.');
            }

            return [
                'Jeeves focus plan',
                ...actions.slice(0, 3).map((action, index) => `${index + 1}. ${action}`),
            ].join('\n');
        },
    },
};
