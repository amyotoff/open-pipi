import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        HOME_ASSISTANT_URL: 'http://127.0.0.1:8123',
        HOME_ASSISTANT_TOKEN: 'test-token',
        HOME_ASSISTANT_READ_ENTITIES: 'sensor.kitchen_temperature',
        HOME_ASSISTANT_CONTROL_ENTITIES: 'light.kitchen',
    };
});

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('home_assistant skill', () => {
    it('is owner-only and delegated-only', async () => {
        const { default: skill } = await import('./home-assistant.skill');

        expect(skill.meta).toMatchObject({
            visibility: 'owner',
            delegated_only: true,
            host_owner_only: true,
            approval: 'none',
        });
        expect(skill.tools.map((tool) => tool.name)).toEqual([
            'home_assistant_status',
            'home_assistant_list_entities',
            'home_assistant_get_state',
            'home_assistant_control',
        ]);
    });

    it('rejects unknown arguments before any network request', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { default: skill } = await import('./home-assistant.skill');

        const result = skill.handlers.home_assistant_get_state({
            entity_id: 'sensor.kitchen_temperature',
            url: 'http://evil.test',
        });

        await expect(result).rejects.toThrow('Unknown Home Assistant argument');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('declares exact-call resumable approval after a pure canonical preflight', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { default: skill } = await import('./home-assistant.skill');

        expect(skill.toolMeta?.home_assistant_control).toMatchObject({
            approval: 'explicit',
            approval_action: 'home_assistant_control',
            approval_detail_fields: ['entity_id', 'action', 'value'],
            approval_action_fields: ['entity_id', 'action', 'value'],
            approval_single_use: true,
            approval_resume: true,
        });
        expect(skill.preflight?.home_assistant_control({ entity_id: 'LIGHT.KITCHEN', action: 'turn_off' })).toEqual({
            entity_id: 'light.kitchen',
            action: 'turn_off',
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed on dangerous domains even if the model supplies one', async () => {
        process.env.HOME_ASSISTANT_CONTROL_ENTITIES = 'lock.front_door';
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { default: skill } = await import('./home-assistant.skill');

        expect(() =>
            skill.preflight?.home_assistant_control({ entity_id: 'lock.front_door', action: 'turn_on' })
        ).toThrow('not allowed for Home Assistant domain');

        expect(fetchMock).not.toHaveBeenCalled();
    });
});
