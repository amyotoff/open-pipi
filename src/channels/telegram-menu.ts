export type TelegramMenuCommand = {
    command: string;
    description: string;
};

export const TELEGRAM_MENU_COMMANDS: readonly TelegramMenuCommand[] = Object.freeze([
    { command: 'start', description: 'Start or restart' },
    { command: 'today', description: "Open today's dashboard" },
    { command: 'tasks', description: 'Manage reminders and recurring tasks' },
    { command: 'help', description: 'See what I can do' },
    { command: 'setup', description: 'Change assistant settings' },
]);

export const TELEGRAM_DAILY_ACTIONS = Object.freeze([
    { label: 'Brief', callbackData: 'daily:brief' },
    { label: 'Focus', callbackData: 'daily:focus' },
    { label: 'Review day', callbackData: 'daily:review' },
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
            'Daily: /brief, /focus, /plan, /review, /yesterday, /week',
            'Work: /research, /audit, /project, /history, /artifacts, /workspace, /workflow, /gdrive',
            'Routines: /rituals',
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
        '/today — timeline with Brief, Focus, and Review actions',
        '/tasks — reminders and recurring tasks',
        '/setup — assistant settings',
        '',
        'Need technical controls? Use /help advanced.',
    ].join('\n');
}
