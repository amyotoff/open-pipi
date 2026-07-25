/**
 * The narrow waist, enforced.
 *
 * Transport SDKs and transport runtime singletons must stay on the far side of
 * the TransportAdapter boundary. This test reads the source tree and fails when
 * a new module reaches across it, so the boundary survives contributors who
 * have never read the architecture doc.
 *
 * The allowlists below start out containing the violations that already exist.
 * That is deliberate: debt that is visible and prevented from growing beats
 * debt that is invisible. Phase 3 of docs/transport-gateway-plan.md empties the
 * TODO entries; nothing may be added to them in the meantime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.resolve(__dirname, '..');

/** npm packages that speak a specific wire protocol. */
const TRANSPORT_SDK_PACKAGES = ['telegraf', 'discord.js', '@whiskeysockets/baileys', '@hapi/boom', 'nodemailer'];

/**
 * Files allowed to import a transport SDK, by the SDK they may import.
 * A file appears here only if it *is* the adapter for that transport.
 */
const SDK_IMPORT_ALLOWLIST: Record<string, string[]> = {
    telegraf: [
        'src/channels/telegram-bot.ts',
        'src/channels/telegram-commands.ts',
        'src/channels/telegram-send.ts',
        // TODO(phase-3): normalization moves to src/transports/telegram/normalizer.ts
        'src/router.ts',
        // TODO(phase-3): the photo path moves into the Telegram adapter
        'src/agents/butler.ts',
    ],
    'discord.js': ['src/channels/discord.ts'],
    '@whiskeysockets/baileys': ['src/channels/whatsapp.ts'],
    '@hapi/boom': ['src/channels/whatsapp.ts'],
    nodemailer: ['src/channels/gmail.ts'],
};

/** Modules that hold a live transport connection rather than a pure function. */
const TRANSPORT_RUNTIME_MODULES = [
    'src/channels/telegram.ts',
    'src/channels/telegram-bot.ts',
    'src/channels/telegram-send.ts',
    'src/channels/telegram-commands.ts',
];

/**
 * Files allowed to import a transport runtime module. Composition roots and the
 * transport's own siblings qualify; agents, skills, and core logic do not.
 */
const RUNTIME_IMPORT_ALLOWLIST = [
    // Composition root: bootstrap wires transports together.
    'src/index.ts',
    // TODO(phase-3): butler reaches for `bot` to download photos; the adapter
    // will hand it a resolved attachment instead.
    'src/agents/butler.ts',
];

function listSourceFiles(directory: string): string[] {
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    return entries.flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return listSourceFiles(absolute);
        return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
    });
}

/** Static imports, dynamic imports, and requires — every way a module can be pulled in. */
function readModuleSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const patterns = [
        /\bfrom\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            specifiers.push(match[1]);
        }
    }

    return specifiers;
}

function toRepoRelative(absolutePath: string): string {
    return path.relative(path.resolve(srcRoot, '..'), absolutePath).split(path.sep).join('/');
}

/** Resolve a relative specifier to a repo-relative `.ts` path, or null if it is a package. */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;

    const resolved = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [`${resolved}.ts`, path.join(resolved, 'index.ts')];
    const match = candidates.find((candidate) => fs.existsSync(candidate));

    return match ? toRepoRelative(match) : null;
}

function matchesPackage(specifier: string, packageName: string): boolean {
    return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

const sourceFiles = listSourceFiles(srcRoot);

describe('transport boundary', () => {
    it('finds source files to inspect', () => {
        expect(sourceFiles.length).toBeGreaterThan(100);
    });

    it('keeps transport SDKs behind the adapter boundary', () => {
        const violations: string[] = [];

        for (const absolutePath of sourceFiles) {
            const relativePath = toRepoRelative(absolutePath);
            const specifiers = readModuleSpecifiers(fs.readFileSync(absolutePath, 'utf-8'));

            for (const packageName of TRANSPORT_SDK_PACKAGES) {
                if (!specifiers.some((specifier) => matchesPackage(specifier, packageName))) continue;
                if (SDK_IMPORT_ALLOWLIST[packageName]?.includes(relativePath)) continue;

                violations.push(
                    `${relativePath} imports "${packageName}". Translate it into src/transports/types.ts ` +
                        `inside that transport's adapter instead, or add the file to SDK_IMPORT_ALLOWLIST ` +
                        `if it genuinely is that adapter.`
                );
            }
        }

        expect(violations).toEqual([]);
    });

    it('keeps live transport connections out of core, agents, and skills', () => {
        const violations: string[] = [];

        for (const absolutePath of sourceFiles) {
            const relativePath = toRepoRelative(absolutePath);
            if (relativePath.endsWith('.test.ts')) continue;
            if (relativePath.startsWith('src/channels/')) continue;
            if (relativePath.startsWith('src/transports/')) continue;
            if (RUNTIME_IMPORT_ALLOWLIST.includes(relativePath)) continue;

            const specifiers = readModuleSpecifiers(fs.readFileSync(absolutePath, 'utf-8'));

            for (const specifier of specifiers) {
                const target = resolveRelativeSpecifier(absolutePath, specifier);
                if (!target || !TRANSPORT_RUNTIME_MODULES.includes(target)) continue;

                violations.push(
                    `${relativePath} imports "${target}". Send through the outbox via ` +
                        `src/channels/runtime.ts instead of touching a transport connection directly.`
                );
            }
        }

        expect(violations).toEqual([]);
    });

    it('keeps the phase-3 debt visible and bounded', () => {
        // These entries exist only until the Telegram adapter lands. If a phase-3
        // PR removes a violation, delete its allowlist entry in the same PR —
        // this assertion is the reminder.
        expect(SDK_IMPORT_ALLOWLIST.telegraf).toContain('src/router.ts');
        expect(SDK_IMPORT_ALLOWLIST.telegraf).toContain('src/agents/butler.ts');
        expect(RUNTIME_IMPORT_ALLOWLIST).toContain('src/agents/butler.ts');

        const totalAllowed = Object.values(SDK_IMPORT_ALLOWLIST).reduce((sum, files) => sum + files.length, 0);
        expect(totalAllowed).toBe(9);
    });
});
