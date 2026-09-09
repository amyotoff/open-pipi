import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { buildOnboardingStaticSite } from '../agent-onboarding/static-site';

export function buildOnboardingRelease(
    cwd: string,
    git = (args: string[]): string =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
        }).trim()
): { outputDir: string; sourceCommit: string; files: string[] } {
    if (git(['status', '--porcelain']))
        throw new Error('Commit all reviewed changes before building a public release.');
    const sourceCommit = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('A full release commit is required.');
    // Query the official public repository directly, independently of a checkout's origin.
    // Requiring an advertised tip is deliberately stricter than trusting stale local refs.
    const published = git([
        'ls-remote',
        'https://github.com/amyotoff/open-pipi.git',
        'HEAD',
        'refs/heads/*',
        'refs/tags/*',
    ]);
    if (!published.split('\n').some((line) => line.split(/\s+/)[0] === sourceCommit)) {
        throw new Error('Push the reviewed commit to the official repository before building a public release.');
    }
    const tempRoot = path.join(cwd, '.tmp');
    mkdirSync(tempRoot, { recursive: true });
    const outputDir = mkdtempSync(path.join(tempRoot, 'onboarding-public-'));
    const files = buildOnboardingStaticSite({ outputDir, sourceCommit });
    return { outputDir, sourceCommit, files };
}

if (require.main === module) {
    try {
        if (process.argv.slice(2).some((argument) => argument !== '--'))
            throw new Error('This build command takes no options.');
        process.stdout.write(JSON.stringify(buildOnboardingRelease(process.cwd()), null, 2) + '\n');
    } catch (error) {
        process.stderr.write(
            error instanceof Error && /^(Commit all|Push the reviewed)/.test(error.message)
                ? `${error.message}\n`
                : 'Could not build the public onboarding release. Check the source checkout and public files.\n'
        );
        process.exitCode = 1;
    }
}
