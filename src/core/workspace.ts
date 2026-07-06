import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getActiveProjectForSpace, linkProjectTarget } from '../db';
import { resolveSpacePolicy } from './policy';
import { validateWorkspaceRootPath } from './workspace-path';

type WorkspaceEntry = {
    name: string;
    relative_path: string;
    type: 'file' | 'dir';
    size: number;
};

type WorkspaceSnapshot = {
    root: string;
    exists: boolean;
    entries: string[];
};

function requireWorkspaceRoot(spaceId: string): string {
    const root = resolveSpacePolicy(spaceId).workspace_path;
    if (!root) {
        throw new Error('No workspace is attached to this space.');
    }

    const validated = validateWorkspaceRootPath(root);
    if (!validated.ok) {
        throw new Error(validated.message);
    }

    return validated.resolvedPath;
}

function sanitizeRelativePath(relativePath: string | undefined): string {
    const raw = (relativePath || '.').trim();
    if (!raw || raw === '.') return '.';
    if (path.isAbsolute(raw)) {
        throw new Error('Workspace paths must be relative to the attached workspace.');
    }

    const normalized = path.normalize(raw);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new Error('Workspace paths cannot escape the attached workspace.');
    }

    return normalized;
}

async function resolveAbsolutePath(
    spaceId: string,
    relativePath?: string
): Promise<{ root: string; absolutePath: string; relativePath: string }> {
    const root = requireWorkspaceRoot(spaceId);
    const safeRelativePath = sanitizeRelativePath(relativePath);
    const absolutePath = path.resolve(root, safeRelativePath === '.' ? '' : safeRelativePath);

    const relativeToRoot = path.relative(root, absolutePath);
    if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`)) {
        throw new Error('Resolved path escapes the attached workspace.');
    }

    return { root, absolutePath, relativePath: safeRelativePath };
}

export async function getWorkspaceStatus(spaceId: string): Promise<{ root: string; exists: boolean }> {
    const root = requireWorkspaceRoot(spaceId);
    try {
        const stat = await fsp.stat(root);
        return { root, exists: stat.isDirectory() };
    } catch {
        return { root, exists: false };
    }
}

function shouldSkipEntry(name: string): boolean {
    return name.startsWith('.') || ['node_modules', '.git'].includes(name);
}

export function getWorkspaceSnapshot(spaceId: string, limit: number = 8): WorkspaceSnapshot {
    const root = requireWorkspaceRoot(spaceId);
    try {
        const stat = fs.statSync(root);
        if (!stat.isDirectory()) {
            return { root, exists: false, entries: [] };
        }

        const entries = fs
            .readdirSync(root, { withFileTypes: true })
            .filter((dirent) => !shouldSkipEntry(dirent.name))
            .sort(
                (left, right) =>
                    Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name)
            )
            .slice(0, limit)
            .map((dirent) => `${dirent.name}${dirent.isDirectory() ? '/' : ''}`);

        return { root, exists: true, entries };
    } catch {
        return { root, exists: false, entries: [] };
    }
}

export async function listWorkspaceEntries(
    spaceId: string,
    relativePath?: string,
    limit: number = 40
): Promise<WorkspaceEntry[]> {
    const { absolutePath, relativePath: safeRelativePath } = await resolveAbsolutePath(spaceId, relativePath);
    const dirents = await fsp.readdir(absolutePath, { withFileTypes: true });
    const selected = dirents
        .filter((dirent) => !shouldSkipEntry(dirent.name))
        .sort(
            (left, right) =>
                Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name)
        )
        .slice(0, limit);

    return Promise.all(
        selected.map(async (dirent) => {
            const childRelativePath =
                safeRelativePath === '.'
                    ? dirent.name
                    : path.posix.join(safeRelativePath.split(path.sep).join(path.posix.sep), dirent.name);
            const stat = await fsp.stat(path.join(absolutePath, dirent.name));
            return {
                name: dirent.name,
                relative_path: childRelativePath,
                type: dirent.isDirectory() ? 'dir' : 'file',
                size: stat.size,
            };
        })
    );
}

export async function readWorkspaceText(
    spaceId: string,
    relativePath: string,
    maxChars: number = 12000
): Promise<string> {
    const { absolutePath } = await resolveAbsolutePath(spaceId, relativePath);
    const buffer = await fsp.readFile(absolutePath);
    const preview = buffer.subarray(0, Math.min(buffer.length, maxChars));
    if (preview.includes(0)) {
        throw new Error('This file does not look like plain text.');
    }

    const text = preview.toString('utf-8');
    return buffer.length > maxChars ? `${text}\n\n[TRUNCATED]` : text;
}

function slugify(value: string): string {
    return (
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'artifact'
    );
}

export async function writeWorkspaceArtifact(
    spaceId: string,
    title: string,
    content: string,
    folder: string = 'artifacts'
): Promise<{ absolutePath: string; relativePath: string }> {
    const root = requireWorkspaceRoot(spaceId);
    const safeFolder = slugify(folder);
    const artifactDir = path.join(root, '.pipi', safeFolder);
    await fsp.mkdir(artifactDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${stamp}-${slugify(title)}.md`;
    const absolutePath = path.join(artifactDir, fileName);
    const body = `# ${title.trim()}\n\n${content.trim()}\n`;
    await fsp.writeFile(absolutePath, body, 'utf-8');

    const relativePath = path.posix.join('.pipi', safeFolder, fileName);
    const activeProject = getActiveProjectForSpace(spaceId);
    if (activeProject) {
        linkProjectTarget(activeProject.id, 'artifact', relativePath);
    }

    return {
        absolutePath,
        relativePath,
    };
}

async function walkWorkspace(
    absolutePath: string,
    relativePrefix: string,
    options: {
        maxDepth: number;
        maxEntries: number;
    },
    collector: Array<{ absolutePath: string; relativePath: string }>
): Promise<void> {
    if (collector.length >= options.maxEntries) return;
    if (options.maxDepth < 0) return;

    const dirents = await fsp.readdir(absolutePath, { withFileTypes: true });
    for (const dirent of dirents) {
        if (collector.length >= options.maxEntries) break;
        if (shouldSkipEntry(dirent.name)) continue;

        const absoluteChild = path.join(absolutePath, dirent.name);
        const relativeChild = relativePrefix ? path.posix.join(relativePrefix, dirent.name) : dirent.name;

        collector.push({ absolutePath: absoluteChild, relativePath: relativeChild });

        if (dirent.isDirectory()) {
            await walkWorkspace(
                absoluteChild,
                relativeChild,
                { ...options, maxDepth: options.maxDepth - 1 },
                collector
            );
        }
    }
}

export async function findWorkspaceFiles(
    spaceId: string,
    query: string,
    limit: number = 20
): Promise<Array<{ relative_path: string; type: 'file' | 'dir' }>> {
    const { absolutePath } = await resolveAbsolutePath(spaceId, '.');
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const seen: Array<{ absolutePath: string; relativePath: string }> = [];
    await walkWorkspace(absolutePath, '', { maxDepth: 4, maxEntries: 300 }, seen);

    const matches = [];
    for (const entry of seen) {
        if (!entry.relativePath.toLowerCase().includes(normalizedQuery)) continue;
        const stat = await fsp.stat(entry.absolutePath);
        matches.push({
            relative_path: entry.relativePath,
            type: stat.isDirectory() ? ('dir' as const) : ('file' as const),
        });
        if (matches.length >= limit) break;
    }

    return matches;
}

export async function findWorkspaceText(
    spaceId: string,
    query: string,
    limit: number = 20
): Promise<Array<{ relative_path: string; preview: string }>> {
    const { absolutePath } = await resolveAbsolutePath(spaceId, '.');
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const seen: Array<{ absolutePath: string; relativePath: string }> = [];
    await walkWorkspace(absolutePath, '', { maxDepth: 4, maxEntries: 250 }, seen);

    const matches: Array<{ relative_path: string; preview: string }> = [];
    for (const entry of seen) {
        if (matches.length >= limit) break;

        let stat;
        try {
            stat = await fsp.stat(entry.absolutePath);
        } catch {
            continue;
        }
        if (!stat.isFile() || stat.size > 256_000) continue;

        const buffer = await fsp.readFile(entry.absolutePath);
        const previewBuffer = buffer.subarray(0, 24_000);
        if (previewBuffer.includes(0)) continue;

        const text = previewBuffer.toString('utf-8');
        const index = text.toLowerCase().indexOf(normalizedQuery);
        if (index === -1) continue;

        const excerptStart = Math.max(0, index - 80);
        const excerptEnd = Math.min(text.length, index + normalizedQuery.length + 120);
        const excerpt = text.substring(excerptStart, excerptEnd).replace(/\s+/g, ' ').trim();
        matches.push({
            relative_path: entry.relativePath,
            preview: excerpt,
        });
    }

    return matches;
}

export async function listWorkspaceArtifacts(
    spaceId: string,
    folder: string = 'artifacts',
    limit: number = 20
): Promise<WorkspaceEntry[]> {
    return listWorkspaceEntries(spaceId, path.posix.join('.pipi', slugify(folder)), limit);
}
