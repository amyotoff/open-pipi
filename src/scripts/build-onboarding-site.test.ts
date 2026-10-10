import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOnboardingRelease } from './build-onboarding-site';

const roots: string[] = [];
const commit = 'b'.repeat(40);
function root(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-release-check-'));
    roots.push(directory);
    return directory;
}
afterEach(() => {
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('onboarding publication source gate', () => {
    it('refuses dirty and unpublished code before creating any upload artifact', () => {
        const cwd = root();
        expect(() => buildOnboardingRelease(cwd, () => ' M file.ts')).toThrow('Commit all reviewed');
        expect(fs.readdirSync(cwd)).toEqual([]);
        const git = vi
            .fn()
            .mockReturnValueOnce('')
            .mockReturnValueOnce(commit)
            .mockReturnValueOnce(`${'c'.repeat(40)}\trefs/heads/main`);
        expect(() => buildOnboardingRelease(cwd, git)).toThrow('Push the reviewed commit');
        expect(fs.readdirSync(cwd)).toEqual([]);
    });

    it('pins a commit advertised by the official remote and emits the public artifact', () => {
        const cwd = root();
        const git = vi
            .fn()
            .mockReturnValueOnce('')
            .mockReturnValueOnce(commit)
            .mockReturnValueOnce(`${commit}\trefs/heads/experiment`);
        const result = buildOnboardingRelease(cwd, git);
        expect(git.mock.calls[2][0]).toEqual([
            'ls-remote',
            'https://github.com/amyotoff/open-pipi.git',
            'HEAD',
            'refs/heads/*',
            'refs/tags/*',
        ]);
        expect(result.sourceCommit).toBe(commit);
        expect(
            JSON.parse(fs.readFileSync(path.join(result.outputDir, 'agent-onboarding/release.json'), 'utf8'))
                .sourceCommit
        ).toBe(commit);
    });
});
