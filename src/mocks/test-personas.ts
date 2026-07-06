/**
 * Standard Test Personas
 * As per user rules:
 * - Alice (tg_id: '111', username: 'alice') — основной пользователь
 * - Bob (tg_id: '222', username: 'bob') — второй пользователь
 * - Bender (tg_id: '333', username: 'bender') — бот/система
 */

export const testPersonas = {
    alice: {
        tg_id: '111',
        username: 'alice',
        display_name: 'Alice',
        role: 'owner',
    },
    bob: {
        tg_id: '222',
        username: 'bob',
        display_name: 'Bob',
        role: 'owner',
    },
    bender: {
        tg_id: '333',
        username: 'bender',
        display_name: 'Bender',
        role: 'bot',
    },
};

export function getMockPerson(name: keyof typeof testPersonas) {
    return testPersonas[name];
}
