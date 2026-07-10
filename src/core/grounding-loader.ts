import fs from 'fs';
import path from 'path';
import { getSpace } from '../db';
import type { GroundingPack, InstallableGroundingMeta } from './grounding-types';
import { ensureSpaceBehaviorSnapshot, getSpaceGroundingSnapshotRoot } from './space-behavior';
import { readJsonFrontmatter } from './content-document';

const DEFAULT_INSTALLABLE_GROUNDING_ID = 'jeeves_personal';
const groundingCache = new Map<string, GroundingPack | null>();

function groundingsRoot(): string {
    return path.join(__dirname, '../groundings');
}

function readOptionalMarkdown(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8').trim();
}

function groundingRootForId(groundingId: string): string {
    return path.join(groundingsRoot(), groundingId);
}

function materializeMissingGroundingShim(id: string): GroundingPack {
    return {
        id,
        title: id,
        default_language: null,
        timezone: null,
        memory_focus: [],
        attention_bias: [],
        grounding_text: [
            `The requested grounding pack "${id}" is not installed.`,
            'Do not pretend to know the world-model for this space.',
            'Explain the missing grounding plainly and ask an owner to install or switch it.',
        ].join('\n'),
        people_text: '',
        operating_text: '',
        glossary_text: '',
        source: 'static',
        grounding_root: null,
    };
}

export function listInstallableGroundingIds(): string[] {
    const root = groundingsRoot();
    if (!fs.existsSync(root)) return [];

    return fs
        .readdirSync(root)
        .filter((entry) => fs.existsSync(path.join(root, entry, 'grounding.md')))
        .sort();
}

export function loadGroundingPackFromRootStrict(root: string): GroundingPack {
    const groundingPath = path.join(root, 'grounding.md');
    const peoplePath = path.join(root, 'people.md');
    const operatingPath = path.join(root, 'operating.md');
    const glossaryPath = path.join(root, 'glossary.md');

    for (const requiredPath of [groundingPath, peoplePath, operatingPath]) {
        if (!fs.existsSync(requiredPath)) throw new Error(`Missing required grounding file ${requiredPath}.`);
    }

    const groundingDoc = readJsonFrontmatter<InstallableGroundingMeta>(groundingPath);
    return {
        id: groundingDoc.meta.id,
        title: groundingDoc.meta.title,
        description: groundingDoc.meta.description || null,
        default_language: groundingDoc.meta.default_language || null,
        timezone: groundingDoc.meta.timezone || null,
        memory_focus: groundingDoc.meta.memory_focus || [],
        attention_bias: groundingDoc.meta.attention_bias || [],
        grounding_text: groundingDoc.body,
        people_text: readOptionalMarkdown(peoplePath),
        operating_text: readOptionalMarkdown(operatingPath),
        glossary_text: readOptionalMarkdown(glossaryPath),
        source: 'installable',
        grounding_root: root,
    };
}

function loadGroundingPackFromRootWithCache(root: string, cacheKey: string): GroundingPack | null {
    if (groundingCache.has(cacheKey)) {
        return groundingCache.get(cacheKey) || null;
    }

    if (
        !fs.existsSync(path.join(root, 'grounding.md')) ||
        !fs.existsSync(path.join(root, 'people.md')) ||
        !fs.existsSync(path.join(root, 'operating.md'))
    ) {
        groundingCache.set(cacheKey, null);
        return null;
    }

    try {
        const materialized = loadGroundingPackFromRootStrict(root);

        groundingCache.set(cacheKey, materialized);
        return materialized;
    } catch (error) {
        console.warn(`[GROUNDING] Failed to load installable grounding at "${root}":`, error);
        groundingCache.set(cacheKey, null);
        return null;
    }
}

export function loadGroundingPackFromRoot(root: string): GroundingPack | null {
    return loadGroundingPackFromRootWithCache(root, `root:${root}`);
}

export function loadInstallableGroundingPack(groundingId: string): GroundingPack | null {
    return loadGroundingPackFromRootWithCache(groundingRootForId(groundingId), `pack:${groundingId}`);
}

export function invalidateGroundingRootCache(root: string): void {
    groundingCache.delete(`root:${root}`);
}

export function getGroundingPack(id: string = DEFAULT_INSTALLABLE_GROUNDING_ID): GroundingPack {
    return loadInstallableGroundingPack(id) || materializeMissingGroundingShim(id);
}

export function getGroundingPackIds(): string[] {
    const ids = listInstallableGroundingIds();
    return ids.length > 0 ? ids : [DEFAULT_INSTALLABLE_GROUNDING_ID];
}

export function materializeGroundingForSpace(spaceId: string): GroundingPack {
    ensureSpaceBehaviorSnapshot(spaceId);
    const snapshotRoot = getSpaceGroundingSnapshotRoot(spaceId);
    if (snapshotRoot) {
        return loadGroundingPackFromRoot(snapshotRoot) || getGroundingPack(getSpace(spaceId)?.grounding_pack_id);
    }

    const groundingId = getSpace(spaceId)?.grounding_pack_id || DEFAULT_INSTALLABLE_GROUNDING_ID;
    return getGroundingPack(groundingId);
}
