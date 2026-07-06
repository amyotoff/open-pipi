import { describe, expect, it } from 'vitest';
import { MEMBERS_USAGE, parseMembersCommandRequest } from './members-command';

describe('parseMembersCommandRequest', () => {
    it('defaults to list without args and show when replying', () => {
        expect(parseMembersCommandRequest('/members')).toEqual({ action: 'list' });
        expect(parseMembersCommandRequest('/members', '222')).toEqual({ action: 'show', selector: '222' });
    });

    it('supports explicit selectors including display names with spaces', () => {
        expect(parseMembersCommandRequest('/members show Alice Bob')).toEqual({
            action: 'show',
            selector: 'Alice Bob',
        });
        expect(parseMembersCommandRequest('/members role @alice manager')).toEqual({
            action: 'role',
            selector: '@alice',
            role: 'manager',
        });
        expect(parseMembersCommandRequest('/members rep Alice Bob 80')).toEqual({
            action: 'rep',
            selector: 'Alice Bob',
            reputation_delta: 80,
        });
    });

    it('supports reply-based role, reputation, and trust updates', () => {
        expect(parseMembersCommandRequest('/members role manager', '222')).toEqual({
            action: 'role',
            selector: '222',
            role: 'manager',
        });
        expect(parseMembersCommandRequest('/members rep -50', '222')).toEqual({
            action: 'rep',
            selector: '222',
            reputation_delta: -50,
        });
        expect(parseMembersCommandRequest('/members trust can_assign_tasks on', '222')).toEqual({
            action: 'trust',
            selector: '222',
            flag: 'can_assign_tasks',
            enabled: true,
        });
    });

    it('returns usage for malformed commands', () => {
        expect(parseMembersCommandRequest('/members role Bob captain')).toEqual({
            action: 'usage',
            message: MEMBERS_USAGE,
        });
        expect(parseMembersCommandRequest('/members rep Bob nope')).toEqual({
            action: 'usage',
            message: MEMBERS_USAGE,
        });
        expect(parseMembersCommandRequest('/members trust Bob can_assign_tasks maybe')).toEqual({
            action: 'usage',
            message: MEMBERS_USAGE,
        });
    });
});
