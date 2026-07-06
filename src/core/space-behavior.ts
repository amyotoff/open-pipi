import fs from 'fs';
import path from 'path';
import { getSpace } from '../db';
import { DATA_DIR } from '../config';
import { loadInstallablePack, invalidatePackRootCache } from './pack-loader';
import { invalidateGroundingRootCache, loadInstallableGroundingPack } from './grounding-loader';

export interface SpaceBehaviorSnapshotMeta {
    space_id: string;
    assistant_pack_id: string;
    grounding_pack_id: string;
    created_at: string;
    updated_at: string;
    app_version: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

function appVersion(): string {
    return process.env.npm_package_version || '2.5.0';
}

function encodeSpaceId(spaceId: string): string {
    return Buffer.from(spaceId).toString('base64url');
}

function spaceBehaviorSnapshotsRoot(): string {
    return path.join(DATA_DIR, 'space-behavior');
}

function behaviorRootForSpace(spaceId: string): string {
    return path.join(spaceBehaviorSnapshotsRoot(), encodeSpaceId(spaceId));
}

export function getSpacePackSnapshotRoot(spaceId: string): string | null {
    const root = path.join(behaviorRootForSpace(spaceId), 'pack');
    return fs.existsSync(path.join(root, 'agent.md')) ? root : null;
}

export function getSpaceGroundingSnapshotRoot(spaceId: string): string | null {
    const root = path.join(behaviorRootForSpace(spaceId), 'grounding');
    return fs.existsSync(path.join(root, 'grounding.md')) ? root : null;
}

function manifestPathForSpace(spaceId: string): string {
    return path.join(behaviorRootForSpace(spaceId), 'manifest.json');
}

export function getSpaceBehaviorSnapshotMeta(spaceId: string): SpaceBehaviorSnapshotMeta | null {
    const manifestPath = manifestPathForSpace(spaceId);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SpaceBehaviorSnapshotMeta;
    } catch {
        return null;
    }
}

function copyDirectoryIfExists(source: string | null, destination: string): void {
    if (!source || !fs.existsSync(source)) return;
    fs.cpSync(source, destination, { recursive: true });
}

export function refreshSpaceBehaviorSnapshot(spaceId: string): SpaceBehaviorSnapshotMeta | null {
    const space = getSpace(spaceId);
    if (!space) return null;

    const livePack = loadInstallablePack(space.assistant_pack_id);
    const liveGrounding = loadInstallableGroundingPack(space.grounding_pack_id);
    const targetRoot = behaviorRootForSpace(spaceId);
    const tempRoot = `${targetRoot}.tmp-${Date.now()}`;
    const previous = getSpaceBehaviorSnapshotMeta(spaceId);
    const timestamp = nowIso();
    const manifest: SpaceBehaviorSnapshotMeta = {
        space_id: spaceId,
        assistant_pack_id: space.assistant_pack_id,
        grounding_pack_id: space.grounding_pack_id,
        created_at: previous?.created_at || timestamp,
        updated_at: timestamp,
        app_version: appVersion(),
    };

    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });

    copyDirectoryIfExists(livePack?.pack_root || null, path.join(tempRoot, 'pack'));
    copyDirectoryIfExists(liveGrounding?.grounding_root || null, path.join(tempRoot, 'grounding'));
    fs.writeFileSync(path.join(tempRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(tempRoot, targetRoot);

    const snapshotPackRoot = path.join(targetRoot, 'pack');
    const snapshotGroundingRoot = path.join(targetRoot, 'grounding');
    invalidatePackRootCache(snapshotPackRoot);
    invalidateGroundingRootCache(snapshotGroundingRoot);

    return manifest;
}

export function ensureSpaceBehaviorSnapshot(spaceId: string): SpaceBehaviorSnapshotMeta | null {
    const space = getSpace(spaceId);
    if (!space) return null;

    const manifest = getSpaceBehaviorSnapshotMeta(spaceId);
    const packRoot = getSpacePackSnapshotRoot(spaceId);
    const groundingRoot = getSpaceGroundingSnapshotRoot(spaceId);
    const matchesCurrentSpace =
        manifest?.assistant_pack_id === space.assistant_pack_id &&
        manifest?.grounding_pack_id === space.grounding_pack_id;

    if (manifest && packRoot && groundingRoot && matchesCurrentSpace) {
        return manifest;
    }

    return refreshSpaceBehaviorSnapshot(spaceId);
}
