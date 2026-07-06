import fs from 'fs';
import path from 'path';

const BLOCKED_WORKSPACE_ROOTS = ['/', '/proc', '/sys', '/dev', '/run', '/var/run', '/etc'];

function normalizeAbsolutePath(value: string): string {
    return path.resolve(value);
}

function isBlockedWorkspaceRoot(candidate: string): boolean {
    return BLOCKED_WORKSPACE_ROOTS.some(
        (blockedRoot) => candidate === blockedRoot || candidate.startsWith(`${blockedRoot}${path.sep}`)
    );
}

export function validateWorkspaceRootPath(
    rawPath: string
): { ok: true; resolvedPath: string } | { ok: false; message: string } {
    const candidate = rawPath.trim();
    if (!candidate) {
        return { ok: false, message: 'Workspace path cannot be empty.' };
    }

    if (!path.isAbsolute(candidate)) {
        return { ok: false, message: 'Workspace path must be absolute.' };
    }

    const normalizedCandidate = normalizeAbsolutePath(candidate);
    if (isBlockedWorkspaceRoot(normalizedCandidate)) {
        return { ok: false, message: 'Workspace path points to a protected system location.' };
    }

    let resolvedPath: string;
    try {
        resolvedPath = normalizeAbsolutePath(fs.realpathSync(candidate));
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return { ok: false, message: 'Workspace path does not exist.' };
        }
        return { ok: false, message: `Workspace path is not accessible: ${error.message}` };
    }

    let stat;
    try {
        stat = fs.statSync(resolvedPath);
    } catch (error: any) {
        return { ok: false, message: `Workspace path is not accessible: ${error.message}` };
    }

    if (!stat.isDirectory()) {
        return { ok: false, message: 'Workspace path must point to a directory.' };
    }

    if (isBlockedWorkspaceRoot(resolvedPath)) {
        return { ok: false, message: 'Workspace path points to a protected system location.' };
    }

    return { ok: true, resolvedPath };
}
