import { describe, expect, it } from 'vitest';
import { formatTelegramText } from './telegram-format';

describe('formatTelegramText', () => {
    it('renders basic emphasis and list markers as Telegram HTML', () => {
        const result = formatTelegramText(
            [
                '**Сводка за 30 апреля 2026**',
                '',
                '- **Платежная система**',
                '  - **Kristina:** протестировать оплату',
                '* Amyot: выглядит как KISS option',
            ].join('\n')
        );

        expect(result.html).toBe(
            [
                '<b>Сводка за 30 апреля 2026</b>',
                '',
                '• <b>Платежная система</b>',
                '  ◦ <b>Kristina:</b> протестировать оплату',
                '• Amyot: выглядит как KISS option',
            ].join('\n')
        );
        expect(result.plain).toContain('• Платежная система');
    });

    it('escapes user text before applying allowed formatting', () => {
        const result = formatTelegramText('**A&B <draft>**\n- https://example.com?a=1&b=2');

        expect(result.html).toBe('<b>A&amp;B &lt;draft&gt;</b>\n• https://example.com?a=1&amp;b=2');
        expect(result.plain).toBe('A&B <draft>\n• https://example.com?a=1&b=2');
    });
});
