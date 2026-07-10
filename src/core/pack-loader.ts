import { Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import {
    InstallableAgentMeta,
    InstallableSkillsMeta,
    MaterializedAgent,
    PackToolDescriptor,
    PackToolModuleExport,
} from './pack-types';
import { materializeCoreToolbox } from './coretoolbox';
import { readJsonFrontmatter } from './content-document';

const packCache = new Map<string, MaterializedAgent | null>();

function packsRoot(): string {
    return path.join(__dirname, '../packs');
}

function dedupeToolScriptPaths(toolDir: string): string[] {
    if (!fs.existsSync(toolDir)) return [];

    const candidates = fs
        .readdirSync(toolDir)
        .filter((file) => file.endsWith('.tool.js') || file.endsWith('.tool.ts'))
        .sort();

    const preferred = new Map<string, string>();
    for (const candidate of candidates) {
        const base = candidate.replace(/\.tool\.(ts|js)$/i, '');
        const existing = preferred.get(base);
        if (!existing || candidate.endsWith('.tool.js')) {
            preferred.set(base, candidate);
        }
    }

    return [...preferred.values()].map((file) => path.join(toolDir, file));
}

function loadPackTools(packRoot: string, strict = false): PackToolDescriptor[] {
    const toolDir = path.join(packRoot, 'tools');
    const toolPaths = dedupeToolScriptPaths(toolDir);
    const projectRoot = path.join(packRoot, '..', '..');

    return toolPaths.flatMap((toolPath) => {
        try {
            const loaded = require(toolPath) as { packTool?: PackToolModuleExport; default?: PackToolModuleExport };
            const packTool = loaded.packTool || loaded.default;
            if (!packTool?.id || !packTool.title || !packTool.description || typeof packTool.run !== 'function') {
                if (strict) throw new Error(`Pack tool ${toolPath} must export id, title, description, and run.`);
                return [];
            }

            return [
                {
                    id: packTool.id,
                    title: packTool.title,
                    description: packTool.description,
                    script_path: toolPath,
                    script_relative_path: path.relative(projectRoot, toolPath).split(path.sep).join(path.posix.sep),
                    execution: packTool.execution,
                    declaration: {
                        name: packTool.id,
                        description: packTool.description,
                        parameters: packTool.parameters || { type: Type.OBJECT, properties: {} },
                    },
                    run: packTool.run,
                },
            ];
        } catch (error) {
            if (strict) throw new Error(`Failed to load pack tool module ${toolPath}.`, { cause: error });
            console.warn(`[PACK] Failed to load tool module ${toolPath}:`, error);
            return [];
        }
    });
}

function packRootForId(packId: string): string {
    return path.join(packsRoot(), packId);
}

export function listInstallablePackIds(): string[] {
    const root = packsRoot();
    if (!fs.existsSync(root)) return [];

    return fs
        .readdirSync(root)
        .filter((entry) => fs.existsSync(path.join(root, entry, 'agent.md')))
        .sort();
}

function materializePackFromRoot(root: string, strictTools: boolean): MaterializedAgent {
    const agentPath = path.join(root, 'agent.md');
    const skillsPath = path.join(root, 'skills.md');
    const toolsPath = path.join(root, 'tools.md');

    if (!fs.existsSync(agentPath)) throw new Error(`Missing required pack file ${agentPath}.`);
    if (!fs.existsSync(skillsPath)) throw new Error(`Missing required pack file ${skillsPath}.`);

    const agentDoc = readJsonFrontmatter<InstallableAgentMeta>(agentPath);
    const skillsDoc = readJsonFrontmatter<InstallableSkillsMeta>(skillsPath);
    const toolsDoc = fs.existsSync(toolsPath) ? fs.readFileSync(toolsPath, 'utf-8').trim() : '';
    const packTools = loadPackTools(root, strictTools);

    return {
        id: agentDoc.meta.id,
        persona_id: agentDoc.meta.persona_id,
        enabled_capabilities: skillsDoc.meta.enabled_capabilities || [],
        memory_rules: agentDoc.meta.memory_rules || [],
        seeded_tasks: agentDoc.meta.seeded_tasks || [],
        default_policies: agentDoc.meta.default_policies || {},
        authority_presets: agentDoc.meta.authority_presets || {},
        onboarding_hints: agentDoc.meta.onboarding_hints,
        system_prompt_path: agentPath,
        system_prompt: agentDoc.body,
        skills_doc: skillsDoc.body,
        tools_doc: toolsDoc,
        core_toolbox: materializeCoreToolbox(skillsDoc.meta.enabled_capabilities || []),
        pack_tools: packTools,
        source: 'installable',
        pack_root: root,
    };
}

export function loadPackFromRootStrict(root: string): MaterializedAgent {
    return materializePackFromRoot(root, true);
}

function loadPackFromRootWithCache(root: string, cacheKey: string): MaterializedAgent | null {
    if (packCache.has(cacheKey)) {
        return packCache.get(cacheKey) || null;
    }

    if (!fs.existsSync(path.join(root, 'agent.md')) || !fs.existsSync(path.join(root, 'skills.md'))) {
        packCache.set(cacheKey, null);
        return null;
    }

    try {
        const materialized = materializePackFromRoot(root, false);

        packCache.set(cacheKey, materialized);
        return materialized;
    } catch (error) {
        console.warn(`[PACK] Failed to materialize installable pack at "${root}":`, error);
        packCache.set(cacheKey, null);
        return null;
    }
}

export function loadPackFromRoot(root: string): MaterializedAgent | null {
    return loadPackFromRootWithCache(root, `root:${root}`);
}

export function loadInstallablePack(packId: string): MaterializedAgent | null {
    return loadPackFromRootWithCache(packRootForId(packId), `pack:${packId}`);
}

export function invalidatePackRootCache(root: string): void {
    packCache.delete(`root:${root}`);
}
