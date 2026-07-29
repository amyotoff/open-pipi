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

    it('renders markdown headings and removes horizontal-rule markup', () => {
        const result = formatTelegramText(
            [
                '### 🟢 Кристина (Продажи и Контент)',
                '**Приоритет 1: Запуск воронки**',
                '- **Реферальная программа:** Разработать условия.',
                '',
                '---',
                '',
                '### **🔵 Леша (Продукт и Инфраструктура)**',
            ].join('\n')
        );

        expect(result.html).toBe(
            [
                '<b>🟢 Кристина (Продажи и Контент)</b>',
                '<b>Приоритет 1: Запуск воронки</b>',
                '• <b>Реферальная программа:</b> Разработать условия.',
                '',
                '<b>🔵 Леша (Продукт и Инфраструктура)</b>',
            ].join('\n')
        );
        expect(result.plain).not.toMatch(/###|---/);
    });
});
