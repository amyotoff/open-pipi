import { getSpace, listGroundingOverrides } from '../db';
import { materializeGroundingForSpace } from './grounding-loader';
import type { GroundingOverride, GroundingPack } from './grounding-types';

export interface GroundingSnapshot {
    pack: GroundingPack;
    overrides: GroundingOverride[];
}

export function getGroundingSnapshot(spaceId: string): GroundingSnapshot | null {
    const space = getSpace(spaceId);
    if (!space) return null;

    return {
        pack: materializeGroundingForSpace(spaceId),
        overrides: listGroundingOverrides(spaceId),
    };
}

export function getGroundingContext(spaceId: string): string {
    const snapshot = getGroundingSnapshot(spaceId);
    if (!snapshot) return '';

    const { pack, overrides } = snapshot;
    const sections: string[] = [`[GROUNDING]\nPack: ${pack.id}\nTitle: ${pack.title}`];

    if (pack.default_language) {
        sections.push(`Default language: ${pack.default_language}`);
    }
    if (pack.timezone) {
        sections.push(`Preferred timezone: ${pack.timezone}`);
    }
    if (pack.memory_focus.length > 0) {
        sections.push(`Memory focus: ${pack.memory_focus.join(', ')}`);
    }
    if (pack.attention_bias.length > 0) {
        sections.push(`Attention bias: ${pack.attention_bias.join(', ')}`);
    }
    if (pack.grounding_text) {
        sections.push(`World model:\n${pack.grounding_text}`);
    }
    if (pack.people_text) {
        sections.push(`People and roles:\n${pack.people_text}`);
    }
    if (pack.operating_text) {
        sections.push(`Operating model:\n${pack.operating_text}`);
    }
    if (pack.glossary_text) {
        sections.push(`Glossary:\n${pack.glossary_text}`);
    }
    if (overrides.length > 0) {
        sections.push(
            `\n[GROUNDING_OVERRIDES]\n${overrides
                .slice(0, 8)
                .map((override) => `- ${override.kind} / ${override.subject}: ${override.content}`)
                .join('\n')}`
        );
    } else {
        sections.push(
            `\n[GROUNDING_GAPS]\nNo overrides recorded yet for this space. When the user mentions their name, timezone, key people, or standing rules, capture them silently with grounding_add_override (kind: person / place / org / rule). Ask for at most one missing fact if it would materially change your response.`
        );
    }

    return sections.join('\n');
}
