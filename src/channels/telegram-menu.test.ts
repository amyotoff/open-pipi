import { describe, expect, it } from 'vitest';
import { buildTelegramHelpMessage, TELEGRAM_MENU_COMMANDS, TELEGRAM_SETUP_ACTIONS } from './telegram-menu';

describe('Telegram product menu', () => {
    it('keeps the visible menu compact and outcome-oriented', () => {
        expect(TELEGRAM_MENU_COMMANDS).toHaveLength(8);
        expect(TELEGRAM_MENU_COMMANDS.map((item) => item.command)).toEqual([
            'start',
            'help',
            'brief',
            'focus',
            'plan',
            'today',
            'tasks',
            'setup',
        ]);
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
});
