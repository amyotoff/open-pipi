import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOnboardingStaticSite } from './static-site';
import { ONBOARDING_DOCUMENT_FILES, getOnboardingPublicDocument } from './public';

const roots: string[] = [];
const commit = 'a'.repeat(40);
const root = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-public-site-'));
    roots.push(value);
    return value;
};
afterEach(() => {
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('public onboarding release artifact', () => {
    it('exports only the explicit public files and pins the source checkout', () => {
        const outputDir = root();
        const files = buildOnboardingStaticSite({ outputDir, sourceCommit: commit });
        expect(files).toHaveLength(13);
        const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'agent-onboarding/release.json'), 'utf8'));
        expect(manifest).toEqual({
            schemaVersion: 1,
            repository: 'https://github.com/amyotoff/open-pipi.git',
            sourceCommit: commit,
            releaseKind: 'experimental',
        });
        for (const route of Object.keys(ONBOARDING_DOCUMENT_FILES)) {
            expect(fs.readFileSync(path.join(outputDir, route.slice(1)), 'utf8')).toBe(
                getOnboardingPublicDocument(route)?.body
            );
        }
        expect(files.some((file) => /(?:setup-config|owner-context|node_modules|\.env|\.map|\.ts$)/.test(file))).toBe(
            false
        );
        const headers = fs.readFileSync(path.join(outputDir, '_headers'), 'utf8');
        expect(headers).toContain('/agent-onboarding/SKILL.md\n  Content-Type: text/markdown; charset=utf-8');
        expect(headers).toContain('/agent-onboarding/SKILL.txt\n  Content-Type: text/plain; charset=utf-8');
        expect(headers).toContain("frame-ancestors 'none'");
        expect(headers).toContain('X-Robots-Tag: noindex');
        expect(fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8')).toBe('User-agent: *\nAllow: /\n');
    });

    it('refuses a mixed or stale publication directory instead of uploading extra files', () => {
        const outputDir = root();
        fs.writeFileSync(path.join(outputDir, 'private.txt'), 'synthetic private material');
        expect(() => buildOnboardingStaticSite({ outputDir, sourceCommit: commit })).toThrow('must be empty');
        expect(fs.readdirSync(outputDir)).toEqual(['private.txt']);
    });

    it('rejects branch names and absent release pins before writing', () => {
        const outputDir = path.join(root(), 'not-created');
        for (const sourceCommit of ['', 'main', '123abc', 'A'.repeat(40)]) {
            expect(() => buildOnboardingStaticSite({ outputDir, sourceCommit })).toThrow('full release commit');
        }
        expect(fs.existsSync(outputDir)).toBe(false);
    });

    it('resolves every relative Markdown reference inside the exported package', () => {
        const outputDir = root();
        buildOnboardingStaticSite({ outputDir, sourceCommit: commit });
        for (const route of Object.keys(ONBOARDING_DOCUMENT_FILES)) {
            const filename = path.join(outputDir, route.slice(1));
            const content = fs.readFileSync(filename, 'utf8');
            for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
                if (/^(https?:|#)/.test(match[1])) continue;
                expect(fs.existsSync(path.resolve(path.dirname(filename), match[1])), `${route}: ${match[1]}`).toBe(
                    true
                );
            }
        }
    });
});
