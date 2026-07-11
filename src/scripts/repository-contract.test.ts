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
        expect(packageJson.scripts.verify).toContain('pnpm content:check');
        expect(packageJson.scripts.verify).toContain('pnpm test:coverage');
        expect(packageJson.scripts.verify).toContain('pnpm build');
        expect(packageJson.scripts['release:check']).toBe('pnpm verify && pnpm audit --prod --audit-level=critical');
    });

    it('keeps public version metadata and contributor guidance synchronized', () => {
        const packageJson = JSON.parse(read('package.json')) as { version: string };
        const readme = read('README.md');
        const changelog = read('CHANGELOG.md');
        const pullRequestTemplate = read('.github/PULL_REQUEST_TEMPLATE.md');

        expect(readme).toContain(`version-${packageJson.version}-informational`);
        expect(changelog.indexOf('## [Unreleased]')).toBeGreaterThan(-1);
        expect(changelog.indexOf('## [Unreleased]')).toBeLessThan(changelog.indexOf('## [2.1.0]'));
        expect(pullRequestTemplate).toContain('`pnpm verify` passes');
    });
});
