import path from 'node:path';
import { ContentScaffoldKind, createContentScaffold } from '../core/content-scaffold';

const USAGE = 'Usage: pnpm content:new -- <pack|grounding> <id> [--dry-run] [--json]';

export type ContentNewArgs = {
    kind: ContentScaffoldKind;
    id: string;
    dryRun: boolean;
    json: boolean;
};

export function parseContentNewArgs(argv: string[]): ContentNewArgs {
    const args = argv.filter((arg) => arg !== '--');
    const flags = args.filter((arg) => arg.startsWith('--'));
    const unknownFlags = flags.filter((flag) => !['--dry-run', '--json'].includes(flag));
    const positional = args.filter((arg) => !arg.startsWith('--'));
    const kind = positional[0] as ContentScaffoldKind | undefined;
    const id = positional[1];

    if (unknownFlags.length > 0 || !kind || !['pack', 'grounding'].includes(kind) || !id || positional.length !== 2) {
        throw new Error(USAGE);
    }
    return { kind, id, dryRun: flags.includes('--dry-run'), json: flags.includes('--json') };
}

export function isContentNewCli(argvEntry = process.argv[1], moduleFile = __filename): boolean {
    return require.main === module || Boolean(argvEntry && path.resolve(argvEntry) === path.resolve(moduleFile));
}

if (isContentNewCli()) {
    let json = process.argv.includes('--json');

    try {
        const parsed = parseContentNewArgs(process.argv.slice(2));
        json = parsed.json;
        const { kind, id, dryRun } = parsed;
        const result = createContentScaffold({ projectRoot: process.cwd(), kind, id, dryRun });
        if (json) {
            console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        } else {
            console.log(`${dryRun ? 'Would create' : 'Created'} ${kind} "${id}" at ${result.targetRoot}`);
            for (const file of result.files) console.log(`- ${file}`);
            console.log(dryRun ? 'No files were written.' : 'Next: edit the files, then run pnpm content:check');
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
        else console.error(message);
        process.exitCode = 1;
    }
}
