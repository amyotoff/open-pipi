import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getOnboardingPublicDocument, ONBOARDING_DOCUMENT_FILES, PUBLIC_ONBOARDING_HEADERS } from './public';

/** Export public instructions only. Never copy a repository, dist tree, or DATA_DIR. */
export function buildOnboardingStaticSite(options: {
    outputDir: string;
    sourceCommit: string;
    publicOrigin?: string;
}): string[] {
    if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('A full release commit is required.');
    // Render before touching the destination so missing source documents fail cleanly.
    const routes = {
        'index.html': '/',
        'agent-onboarding/index.html': '/agent-onboarding',
        ...Object.fromEntries(Object.keys(ONBOARDING_DOCUMENT_FILES).map((route) => [route.slice(1), route])),
        'agent-onboarding/release.json': '/agent-onboarding/release.json',
        'agent-onboarding/onboarding.css': '/agent-onboarding/onboarding.css',
        'agent-onboarding/onboarding.js': '/agent-onboarding/onboarding.js',
    };
    const entries = Object.entries(routes).map(([file, route]) => {
        const document = getOnboardingPublicDocument(route, options);
        if (!document) throw new Error('Missing public document.');
        return { file, body: document.body, route, contentType: document.contentType };
    });
    mkdirSync(options.outputDir, { recursive: true });
    if (readdirSync(options.outputDir).length) throw new Error('Publication directory must be empty.');
    for (const entry of entries) {
        const destination = path.join(options.outputDir, entry.file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, entry.body, { encoding: 'utf8', flag: 'wx' });
    }
    const headers =
        '/*\n' +
        Object.entries(PUBLIC_ONBOARDING_HEADERS)
            .map(([key, value]) => `  ${key}: ${value}\n`)
            .join('') +
        '\n' +
        entries
            .filter((entry) => !entry.file.endsWith('.html'))
            .map((entry) => `${entry.route}\n  Content-Type: ${entry.contentType}\n`)
            .join('\n');
    writeFileSync(path.join(options.outputDir, '_headers'), headers, { flag: 'wx' });
    writeFileSync(path.join(options.outputDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', { flag: 'wx' });
    return [...entries.map((entry) => entry.file), '_headers', 'robots.txt'];
}
