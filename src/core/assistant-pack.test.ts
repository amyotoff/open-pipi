import { describe, expect, it } from 'vitest';

describe('core/assistant-pack', () => {
    it('exposes the planned assistant packs with distinct capability sets', async () => {
        const mod = await import('./assistant-pack');

        const ids = mod.getAssistantPackIds();
        const jeeves = mod.materializeAgentForPack('jeeves');
        const officeAgent = mod.materializeAgentForPack('office');
        const tutorAgent = mod.materializeAgentForPack('tutor');
        const reporterAgent = mod.materializeAgentForPack('reporter');
        const tutor = mod.getAssistantPack('tutor');
        const office = mod.getAssistantPack('office');
        const reporter = mod.getAssistantPack('reporter');
        const officeSeeds = mod.getSeededTasksForPack('office');

        expect(ids).toEqual(expect.arrayContaining(['jeeves', 'tutor', 'office', 'reporter']));
        expect(jeeves.source).toBe('installable');
        expect(jeeves.core_toolbox.primitives.map((entry) => entry.id)).toEqual(
            expect.arrayContaining(['web', 'file_search', 'user_info', 'personal_context', 'automations', 'api_tool'])
        );
        expect(jeeves.core_toolbox.system_capabilities.map((entry) => entry.id)).toEqual(
            expect.arrayContaining(['bio', 'execution_runtime'])
        );
        expect(jeeves.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['jeeves_brief_note', 'jeeves_focus_plan', 'jeeves_review_note'])
        );
        expect(jeeves.system_prompt).toContain("You are Jeeves, a gentleman's personal gentleman in digital form.");
        expect(officeAgent.source).toBe('installable');
        expect(officeAgent.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['office_focus_note', 'office_read_google_doc', 'office_standup_note'])
        );
        expect(tutorAgent.source).toBe('installable');
        expect(tutorAgent.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['tutor_progress_note', 'tutor_next_steps_note'])
        );
        expect(reporterAgent.source).toBe('installable');
        expect(reporterAgent.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['reporter_topic_note', 'reporter_assignment_note'])
        );
        expect(tutor.enabled_capabilities).toContain('reminders');
        expect(tutor.enabled_capabilities).toContain('shopping');
        expect(tutor.enabled_capabilities).toContain('workspace');
        expect(tutor.enabled_capabilities).toContain('projects');
        expect(office.enabled_capabilities).toContain('shopping');
        expect(office.enabled_capabilities).toContain('workspace');
        expect(office.enabled_capabilities).toContain('grounding');
        expect(office.enabled_capabilities).toContain('projects');
        expect(office.enabled_capabilities).toContain('family');
        expect(office.family_members).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'researcher', character: 'Sherlock Holmes' })])
        );
        expect(officeSeeds.map((task: any) => task.template_id)).toEqual(
            expect.arrayContaining(['briefing_morning', 'followup_digest', 'atelier_review'])
        );
        expect(reporter.enabled_capabilities).toContain('webrun');
        expect(reporter.enabled_capabilities).toContain('workspace');
        expect(reporter.enabled_capabilities).toContain('grounding');
        expect(reporter.enabled_capabilities).toContain('projects');
        expect(jeeves.enabled_capabilities).toContain('shopping');
        expect(jeeves.enabled_capabilities).toContain('projects');
        expect(jeeves.enabled_capabilities).toContain('family');
        expect(jeeves.enabled_capabilities).toContain('home_assistant');
        expect(jeeves.family_members).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'home_operator', role: 'Home Assistant operator' })])
        );
        expect(jeeves.skills_doc).toContain('member_id: home_operator');
        expect(mod.getSystemPromptForPack('reporter')).toContain('research and reporting assistant');
    });

    it('returns a minimal shim when a requested pack is not installed', async () => {
        const mod = await import('./assistant-pack');

        const missing = mod.materializeAgentForPack('missing_pack');

        expect(missing.id).toBe('missing_pack');
        expect(missing.source).toBe('static');
        expect(missing.enabled_capabilities).toEqual([]);
        expect(missing.core_toolbox.primitives).toHaveLength(6);
        expect(missing.seeded_tasks).toEqual([]);
        expect(missing.system_prompt).toContain('is not installed');
    });
});
