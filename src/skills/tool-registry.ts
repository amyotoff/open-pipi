import type { FunctionDeclaration } from '@google/genai';
import type { CapabilityMeta, SkillManifest } from './_types';

export type SkillToolHandler = SkillManifest['handlers'][string];

export interface RegisteredSkillTool {
    name: string;
    skill: SkillManifest;
    declaration: FunctionDeclaration;
    handler: SkillToolHandler;
    meta: CapabilityMeta;
    approvalAction?: string;
    approvalReason?: string;
}

function resolveMeta(skill: SkillManifest, defaults: CapabilityMeta): CapabilityMeta {
    return {
        ...defaults,
        ...(skill.meta || {}),
        pack_tags: [...(skill.meta?.pack_tags || defaults.pack_tags)],
    };
}

export function buildSkillToolRegistry(
    skills: SkillManifest[],
    defaultMeta: CapabilityMeta
): ReadonlyMap<string, RegisteredSkillTool> {
    const registry = new Map<string, RegisteredSkillTool>();

    for (const skill of skills) {
        const meta = resolveMeta(skill, defaultMeta);
        const declaredNames = new Set<string>();

        for (const declaration of skill.tools) {
            const name = declaration.name?.trim();
            if (!name) {
                throw new Error(`Skill "${skill.name}" contains a tool declaration without a name.`);
            }

            const existing = registry.get(name);
            if (existing) {
                throw new Error(
                    `Duplicate tool "${name}" declared by skills "${existing.skill.name}" and "${skill.name}".`
                );
            }

            const handler = skill.handlers[name];
            if (!handler) {
                throw new Error(`Skill "${skill.name}" declares tool "${name}" without a handler.`);
            }

            const toolMeta = skill.toolMeta?.[name];
            declaredNames.add(name);
            registry.set(name, {
                name,
                skill,
                declaration,
                handler,
                meta: {
                    ...meta,
                    run_mode: toolMeta?.run_mode || meta.run_mode,
                    approval: toolMeta?.approval || meta.approval,
                },
                approvalAction: toolMeta?.approval_action,
                approvalReason: toolMeta?.approval_reason,
            });
        }

        for (const handlerName of Object.keys(skill.handlers)) {
            if (!declaredNames.has(handlerName)) {
                throw new Error(`Skill "${skill.name}" registers handler "${handlerName}" without a declaration.`);
            }
        }

        for (const toolMetaName of Object.keys(skill.toolMeta || {})) {
            if (!declaredNames.has(toolMetaName)) {
                throw new Error(`Skill "${skill.name}" defines metadata for unknown tool "${toolMetaName}".`);
            }
        }
    }

    return registry;
}
