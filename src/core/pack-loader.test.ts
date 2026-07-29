import { describe, expect, it } from 'vitest';
import path from 'path';

describe('core/pack-loader', () => {
    it('loads the installable Jeeves pack from its folder', async () => {
        const loader = await import('./pack-loader');
        const pack = loader.loadInstallablePack('jeeves');

        expect(pack).not.toBeNull();
        expect(pack?.id).toBe('jeeves');
        expect(pack?.source).toBe('installable');
        expect(pack?.enabled_capabilities).toContain('shopping');
        expect(pack?.enabled_capabilities).toContain('memory');
        expect(pack?.enabled_capabilities).toContain('grounding');
        expect(
            pack?.core_toolbox.primitives.find((entry) => entry.id === 'personal_context')?.backing_capabilities
        ).toEqual(expect.arrayContaining(['memory', 'history', 'members', 'spaces']));
        expect(pack?.seeded_tasks.map((task) => task.template_id)).toEqual(
            expect.arrayContaining(['briefing_morning', 'consideration_afternoon', 'wrapup_evening', 'atelier_review'])
        );
        expect(pack?.system_prompt).toContain('You are Jeeves');
        expect(pack?.character_doc).toContain('decision-making reference');
        expect(pack?.system_prompt).toContain('[BEHAVIOR_CALIBRATION]');
        expect(pack?.system_prompt).toContain('Do not imitate quotations');
        expect(pack?.tools_doc).toContain('jeeves_brief_note');
        expect(pack?.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['jeeves_brief_note', 'jeeves_focus_plan', 'jeeves_review_note'])
        );
    });

    it('loads the installable Office pack from its folder', async () => {
        const loader = await import('./pack-loader');
        const pack = loader.loadInstallablePack('office');

        expect(pack).not.toBeNull();
        expect(pack?.id).toBe('office');
        expect(pack?.persona_id).toBe('alfred');
        expect(pack?.source).toBe('installable');
        expect(pack?.enabled_capabilities).toContain('shopping');
        expect(pack?.enabled_capabilities).toContain('workspace');
        expect(pack?.enabled_capabilities).toContain('grounding');
        expect(pack?.seeded_tasks.map((task) => task.template_id)).toEqual(
            expect.arrayContaining(['briefing_morning', 'followup_digest', 'atelier_review'])
        );
        expect(pack?.system_prompt).toContain('discreet operational steward');
        expect(pack?.family_members).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'researcher', role: 'Researcher', character: 'Sherlock Holmes' }),
            ])
        );
        expect(pack?.character_doc).toContain('Alfred Pennyworth');
        expect(pack?.character_doc).toContain('not as a roleplay costume');
        expect(pack?.tools_doc).toContain('office_focus_note');
        expect(pack?.tools_doc).toContain('office_kanban_board');
        expect(pack?.tools_doc).toContain('office_read_google_doc');
        expect(pack?.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining([
                'office_focus_note',
                'office_kanban_board',
                'office_read_google_doc',
                'office_standup_note',
            ])
        );
    });

    it('loads pack tools when a materialized snapshot root is relative', async () => {
        const loader = await import('./pack-loader');
        const relativeRoot = path.relative(process.cwd(), path.join(__dirname, '../packs/office'));
        const pack = loader.loadPackFromRoot(relativeRoot);

        expect(pack?.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['office_focus_note', 'office_kanban_board', 'office_read_google_doc'])
        );
        expect(pack?.pack_tools.every((tool) => path.isAbsolute(tool.script_path))).toBe(true);
    });

    it('loads the installable Reporter pack from its folder', async () => {
        const loader = await import('./pack-loader');
        const pack = loader.loadInstallablePack('reporter');

        expect(pack).not.toBeNull();
        expect(pack?.id).toBe('reporter');
        expect(pack?.source).toBe('installable');
        expect(pack?.enabled_capabilities).toContain('webrun');
        expect(pack?.enabled_capabilities).toContain('grounding');
        expect(pack?.enabled_capabilities).not.toContain('ops');
        expect(pack?.seeded_tasks.map((task) => task.template_id)).toEqual(
            expect.arrayContaining(['topic_scan', 'brief_followup'])
        );
        expect(pack?.system_prompt).toContain('research and reporting assistant');
        expect(pack?.tools_doc).toContain('reporter_topic_note');
        expect(pack?.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['reporter_topic_note', 'reporter_assignment_note'])
        );
    });

    it('loads the installable Tutor pack from its folder', async () => {
        const loader = await import('./pack-loader');
        const pack = loader.loadInstallablePack('tutor');

        expect(pack).not.toBeNull();
        expect(pack?.id).toBe('tutor');
        expect(pack?.source).toBe('installable');
        expect(pack?.enabled_capabilities).toContain('shopping');
        expect(pack?.enabled_capabilities).toContain('reminders');
        expect(pack?.enabled_capabilities).toContain('grounding');
        expect(pack?.enabled_capabilities).not.toContain('ops');
        expect(pack?.seeded_tasks.map((task) => task.template_id)).toEqual(
            expect.arrayContaining(['study_checkin', 'assignment_reminder'])
        );
        expect(pack?.system_prompt).toContain('patient educational assistant');
        expect(pack?.tools_doc).toContain('tutor_progress_note');
        expect(pack?.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['tutor_progress_note', 'tutor_next_steps_note'])
        );
    });
});
