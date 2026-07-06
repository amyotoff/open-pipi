import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadGuard(options?: { trust?: Record<string, boolean>; authority?: Record<string, number> }) {
    vi.resetModules();

    const buildTelegramSpaceId = vi.fn((chatId: string) => `telegram:${chatId}`);
    const memberHasTrustFlag = vi.fn((spaceId: string, personId: string, flag: string) => {
        const key = `${personId}:${flag}`;
        return options?.trust?.[key] === true;
    });
    const getMemberEffectiveAuthority = vi.fn(
        (spaceId: string, personId: string) => options?.authority?.[personId] ?? 0
    );

    vi.doMock('../db', () => ({
        buildTelegramSpaceId,
        getSpace: vi.fn(() => undefined),
        getSpaceByChannelRef: vi.fn(() => undefined),
        memberHasTrustFlag,
        getMemberEffectiveAuthority,
    }));

    const mod = await import('./authority-guard');
    return { ...mod, mocks: { memberHasTrustFlag, getMemberEffectiveAuthority } };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/authority-guard', () => {
    it('allows ordinary replies through', async () => {
        const mod = await loadGuard();
        expect(
            mod.evaluateAuthorityGuard({
                spaceId: 'telegram:chat-1',
                senderId: '111',
                text: 'Спасибо, понял',
                replyTarget: { personId: '222', displayName: 'Bob' },
            })
        ).toEqual({ allow: true });
    });

    it('blocks high-impact instructions from members without the trust flag', async () => {
        const mod = await loadGuard({
            authority: { '111': 100, '222': 1000 },
        });

        const result = mod.evaluateAuthorityGuard({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            text: 'Перезапусти сервис и удали старые записи',
            replyTarget: { personId: '222', displayName: 'Bob' },
        });

        expect(result.allow).toBe(false);
        if (!result.allow) {
            expect(result.reason).toContain('high-impact');
        }
    });

    it('blocks override-like replies from members without override trust', async () => {
        const mod = await loadGuard({
            authority: { '111': 100, '222': 100 },
        });

        const result = mod.evaluateAuthorityGuard({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            text: 'Не надо, сделай иначе',
            replyTarget: { personId: '222', displayName: 'Bob' },
        });

        expect(result.allow).toBe(false);
        if (!result.allow) {
            expect(result.reason).toContain('override');
        }
    });

    it('asks for clarification when authority gap is too small', async () => {
        const mod = await loadGuard({
            trust: {
                '111:can_override_instructions': true,
            },
            authority: { '111': 500, '222': 450 },
        });

        const result = mod.evaluateAuthorityGuard({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            text: 'Отмени это и сделай иначе',
            replyTarget: { personId: '222', displayName: 'Bob' },
        });

        expect(result.allow).toBe(false);
        if (!result.allow) {
            expect(result.reason).toContain('близким authority');
        }
    });

    it('allows a clearly higher-authority override with the proper trust flag', async () => {
        const mod = await loadGuard({
            trust: {
                '111:can_override_instructions': true,
                '111:can_issue_high_impact_commands': true,
            },
            authority: { '111': 1000, '222': 100 },
        });

        expect(
            mod.evaluateAuthorityGuard({
                spaceId: 'telegram:chat-1',
                senderId: '111',
                text: 'Отмени это и перезапусти сервис',
                replyTarget: { personId: '222', displayName: 'Bob' },
            })
        ).toEqual({ allow: true });
    });
});
