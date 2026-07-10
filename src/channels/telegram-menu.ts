export type TelegramMenuCommand = {
    command: string;
    description: string;
};

export const TELEGRAM_MENU_COMMANDS: readonly TelegramMenuCommand[] = Object.freeze([
    { command: 'start', description: 'Start or restart' },
    { command: 'help', description: 'See what I can do' },
    { command: 'brief', description: 'Get a useful summary' },
    { command: 'focus', description: "Choose today's focus" },
    { command: 'plan', description: 'Turn a goal into next steps' },
    { command: 'today', description: "See today's timeline" },
    { command: 'tasks', description: 'Manage reminders and recurring tasks' },
    { command: 'setup', description: 'Change assistant settings' },
]);

export const TELEGRAM_SETUP_ACTIONS = Object.freeze([
    { label: 'Use recommended settings', callbackData: 'setup:apply' },
    { label: 'Technical status', callbackData: 'setup:status' },
]);

export function buildTelegramHelpMessage(advanced = false): string {
    if (advanced) {
        return [
            'Advanced commands',
            '',
            'Work: /research, /audit, /project, /history, /artifacts, /workspace, /workflow, /gdrive',
            'Routines: /review, /yesterday, /week, /rituals',
            'Assistant: /channel, /pack, /space, /members, /grounding, /atelier',
            'Operations: /status, /backup, /killswitch, /reset',
            'Consent: /approve, /deny',
            '',
            'Use /help to return to the everyday shortcuts.',
        ].join('\n');
    }

    return [
        'Just write what you need in a normal message.',
        '',
        'For example:',
        '• “Remind me tomorrow at 10 to call Alex.”',
        '• “Make a plan for launching this project.”',
        '• “Summarize what changed today.”',
        '',
        'Useful shortcuts:',
        '/brief — a useful summary',
        '/focus — choose the next focus',
        '/plan — turn a goal into steps',
        '/today — today’s timeline',
        '/tasks — reminders and recurring tasks',
        '/setup — assistant settings',
        '',
        'Need technical controls? Use /help advanced.',
    ].join('\n');
}
