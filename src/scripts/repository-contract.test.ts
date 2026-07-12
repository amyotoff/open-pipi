import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

describe('repository release contract', () => {
    it('keeps local and GitHub quality gates on the same authoritative command', () => {
        const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
        const workflow = read('.github/workflows/ci.yml');

        expect(workflow).toContain('run: pnpm verify');
        expect(workflow).toContain('run: pnpm setup:check -- --json');
        expect(packageJson.scripts.verify).toContain('pnpm content:check');
        expect(packageJson.scripts.verify).toContain('pnpm test:coverage');
        expect(packageJson.scripts.verify).toContain('pnpm build');
        expect(packageJson.scripts['release:check']).toBe('pnpm verify && pnpm audit --prod --audit-level=high');
    });

    it('keeps public version metadata and contributor guidance synchronized', () => {
        const packageJson = JSON.parse(read('package.json')) as { version: string };
        const readme = read('README.md');
        const changelog = read('CHANGELOG.md');
        const pullRequestTemplate = read('.github/PULL_REQUEST_TEMPLATE.md');
        const releaseHeading = `## [${packageJson.version}]`;

        expect(readme).toContain(`version-${packageJson.version}-informational`);
        expect(changelog.indexOf('## [Unreleased]')).toBeGreaterThan(-1);
        expect(changelog).toContain(releaseHeading);
        expect(changelog.indexOf('## [Unreleased]')).toBeLessThan(changelog.indexOf(releaseHeading));
        expect(pullRequestTemplate).toContain('`pnpm verify` passes');
    });

    it('keeps build and package artifacts private, clean, and production-only', () => {
        const packageJson = JSON.parse(read('package.json')) as {
            private: boolean;
            files: string[];
            scripts: Record<string, string>;
        };
        const buildConfig = JSON.parse(read('tsconfig.build.json')) as { exclude: string[] };
        const dockerfile = read('Dockerfile');
        const sandboxDockerfile = read('Dockerfile.sandboxd');
        const workflow = read('.github/workflows/ci.yml');
        const ignoredPatterns = new Set(
            read('.gitignore')
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#'))
        );
        const releasing = read('RELEASING.md');

        expect(packageJson.private).toBe(true);
        expect(packageJson.files).toEqual(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
        expect(packageJson.scripts.prebuild).toBe('pnpm clean');
        expect(packageJson.scripts.build).toContain('tsc -p tsconfig.build.json');
        expect(dockerfile).toContain('COPY tsconfig.json tsconfig.build.json ./');
        expect(sandboxDockerfile).toContain('COPY package.json pnpm-lock.yaml ./');
        expect(sandboxDockerfile).toContain('RUN pnpm install --frozen-lockfile --ignore-scripts');
        expect(sandboxDockerfile).not.toContain('npm ci');
        expect(workflow).toContain('docker build -f Dockerfile.sandboxd -t open-pipi-sandboxd:ci .');
        expect(buildConfig.exclude).toEqual(['src/**/*.test.ts', 'src/mocks/**', 'src/test-helpers/**']);
        for (const pattern of ['*.db', '*.db-wal', '*.db-shm', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm']) {
            expect(ignoredPatterns.has(pattern)).toBe(true);
        }
        expect(releasing).toContain('npm publication is out of scope');
    });
});
