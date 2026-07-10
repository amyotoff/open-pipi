import fs from 'node:fs';

export type JsonFrontmatterDocument<T> = {
    meta: T;
    body: string;
};

export function parseJsonFrontmatter<T>(raw: string, filename: string): JsonFrontmatterDocument<T> {
    const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
    if (!match) {
        throw new Error(`Expected JSON frontmatter in ${filename}.`);
    }

    let meta: unknown;
    try {
        meta = JSON.parse(match[1].trim());
    } catch (error) {
        throw new Error(`Invalid JSON frontmatter in ${filename}.`, { cause: error });
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        throw new Error(`JSON frontmatter in ${filename} must be an object.`);
    }

    return { meta: meta as T, body: match[2].trim() };
}

export function readJsonFrontmatter<T>(filePath: string): JsonFrontmatterDocument<T> {
    return parseJsonFrontmatter<T>(fs.readFileSync(filePath, 'utf-8'), filePath);
}
