export type WorkflowTemplateId = 'tutor_lesson_note' | 'office_followup' | 'reporter_brief' | 'reporter_draft';

export function listWorkflowTemplatesForPack(packId: string): Array<{
    id: WorkflowTemplateId;
    title: string;
    description: string;
    folder: string;
}> {
    if (packId === 'tutor') {
        return [
            {
                id: 'tutor_lesson_note',
                title: 'Lesson note',
                description: 'Capture the learning goal, summary, blockers, and next steps after a lesson.',
                folder: 'tutor',
            },
        ];
    }

    if (packId === 'office') {
        return [
            {
                id: 'office_followup',
                title: 'Team follow-up',
                description: 'Capture a meeting or thread follow-up with decisions, action items, and open questions.',
                folder: 'office',
            },
        ];
    }

    if (packId === 'reporter') {
        return [
            {
                id: 'reporter_brief',
                title: 'Article brief',
                description: 'Capture angle, core brief, source needs, and filing notes before reporting.',
                folder: 'reporter',
            },
            {
                id: 'reporter_draft',
                title: 'Article draft',
                description: 'Save a working article draft with optional editorial notes.',
                folder: 'reporter',
            },
        ];
    }

    return [];
}

function splitBullets(input?: string): string[] {
    return (input || '')
        .split(/\n+/)
        .map((item) => item.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean);
}

export function renderWorkflowArtifact(
    templateId: WorkflowTemplateId,
    args: {
        title: string;
        summary?: string;
        body?: string;
        bullets?: string;
        extra?: string;
    }
): { title: string; content: string; folder: string } {
    const title = args.title.trim();
    const summary = args.summary?.trim() || '';
    const body = args.body?.trim() || '';
    const bullets = splitBullets(args.bullets);
    const extra = splitBullets(args.extra);

    if (templateId === 'tutor_lesson_note') {
        return {
            title,
            folder: 'tutor',
            content: [
                summary ? `## Learning Goal\n\n${summary}` : '',
                body ? `## Lesson Summary\n\n${body}` : '',
                bullets.length > 0 ? `## Key Points\n\n${bullets.map((item) => `- ${item}`).join('\n')}` : '',
                extra.length > 0 ? `## Next Steps\n\n${extra.map((item) => `- ${item}`).join('\n')}` : '',
            ]
                .filter(Boolean)
                .join('\n\n'),
        };
    }

    if (templateId === 'office_followup') {
        return {
            title,
            folder: 'office',
            content: [
                summary ? `## Summary\n\n${summary}` : '',
                body ? `## Decisions\n\n${body}` : '',
                bullets.length > 0 ? `## Action Items\n\n${bullets.map((item) => `- ${item}`).join('\n')}` : '',
                extra.length > 0 ? `## Open Questions\n\n${extra.map((item) => `- ${item}`).join('\n')}` : '',
            ]
                .filter(Boolean)
                .join('\n\n'),
        };
    }

    if (templateId === 'reporter_brief') {
        return {
            title,
            folder: 'reporter',
            content: [
                summary ? `## Angle\n\n${summary}` : '',
                body ? `## Brief\n\n${body}` : '',
                bullets.length > 0 ? `## Source Targets\n\n${bullets.map((item) => `- ${item}`).join('\n')}` : '',
                extra.length > 0 ? `## Filing Notes\n\n${extra.map((item) => `- ${item}`).join('\n')}` : '',
            ]
                .filter(Boolean)
                .join('\n\n'),
        };
    }

    return {
        title,
        folder: 'reporter',
        content: [
            summary ? `## Deck\n\n${summary}` : '',
            body ? `## Draft\n\n${body}` : '',
            bullets.length > 0 ? `## Notes\n\n${bullets.map((item) => `- ${item}`).join('\n')}` : '',
            extra.length > 0 ? `## Editorial Notes\n\n${extra.map((item) => `- ${item}`).join('\n')}` : '',
        ]
            .filter(Boolean)
            .join('\n\n'),
    };
}
