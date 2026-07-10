import { describe, expect, it } from 'vitest';
import {
    buildTelegramHelpMessage,
    TELEGRAM_DAILY_ACTIONS,
    TELEGRAM_MENU_COMMANDS,
    TELEGRAM_SETUP_ACTIONS,
    TELEGRAM_TASK_ACTIONS,
} from './telegram-menu';

describe('Telegram product menu', () => {
    it('keeps the visible menu compact and outcome-oriented', () => {
        expect(TELEGRAM_MENU_COMMANDS).toHaveLength(5);
        expect(TELEGRAM_MENU_COMMANDS.map((item) => item.command)).toEqual([
            'start',
            'today',
            'tasks',
            'help',
            'setup',
        ]);
        expect(TELEGRAM_MENU_COMMANDS.map((item) => item.command)).not.toContain('brief');
        expect(TELEGRAM_MENU_COMMANDS.map((item) => item.command)).not.toContain('focus');
        expect(TELEGRAM_MENU_COMMANDS.map((item) => item.command)).not.toContain('pack');
        expect(TELEGRAM_MENU_COMMANDS.map((item) => item.command)).not.toContain('grounding');
    });

    it('uses progressive disclosure for technical commands', () => {
        const everyday = buildTelegramHelpMessage();
        const advanced = buildTelegramHelpMessage(true);

        expect(everyday).toContain('Just write what you need');
        expect(everyday).toContain('/help advanced');
        expect(everyday).not.toContain('/killswitch');
        expect(advanced).toContain('/killswitch');
        expect(advanced).toContain('/pack');
    });

    it('offers one-tap recommended setup and keeps diagnostics secondary', () => {
        expect(TELEGRAM_SETUP_ACTIONS).toEqual([
            { label: 'Use recommended settings', callbackData: 'setup:apply' },
            { label: 'Technical status', callbackData: 'setup:status' },
        ]);
    });

    it('groups daily outputs behind the today dashboard', () => {
        expect(TELEGRAM_DAILY_ACTIONS).toEqual([
            { label: 'Brief', callbackData: 'daily:brief' },
            { label: 'Focus', callbackData: 'daily:focus' },
            { label: 'Review day', callbackData: 'daily:review' },
        ]);
    });

    it('keeps task discovery one tap away from the task list', () => {
        expect(TELEGRAM_TASK_ACTIONS).toEqual([
            { label: 'Show paused & all', callbackData: 'tasks:all' },
            { label: 'How to add a task', callbackData: 'tasks:add' },
        ]);
    });
});
