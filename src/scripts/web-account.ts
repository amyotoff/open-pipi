/**
 * Create or re-password a local web account.
 *
 *   pnpm web:account -- --username alex --participant 777
 *
 * The password is read from PIPI_WEB_PASSWORD rather than the command line, so
 * it does not end up in shell history or in the process list.
 */

import { closeDatabase, getAllResidents, initDatabase } from '../db';
import { upsertWebAccount } from '../web/auth';

interface Args {
    username?: string;
    participant?: string;
    list?: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {};

    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--list') args.list = true;
        if (flag === '--username') args.username = argv[index + 1];
        if (flag === '--participant') args.participant = argv[index + 1];
    }

    return args;
}

function printParticipants(): void {
    console.log('Known participants:');
    for (const resident of getAllResidents()) {
        const name = resident.nickname || resident.display_name || resident.username || '(no name)';
        console.log(`  ${resident.tg_id}\t${name}\t${resident.role}`);
    }
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    initDatabase();

    try {
        if (args.list || (!args.username && !args.participant)) {
            printParticipants();
            console.log('\nUsage: PIPI_WEB_PASSWORD=... pnpm web:account -- --username <name> --participant <id>');
            return;
        }

        if (!args.username || !args.participant) {
            throw new Error('Both --username and --participant are required.');
        }

        const password = process.env.PIPI_WEB_PASSWORD || '';
        if (!password) {
            throw new Error(
                'Set PIPI_WEB_PASSWORD in the environment. Passing a password as an argument would leave it in shell history.'
            );
        }

        const account = upsertWebAccount({
            username: args.username,
            password,
            participantId: args.participant,
        });

        console.log(`Web account "${account.username}" is linked to participant ${account.participant_id}.`);
        console.log('Signing in over the web now arrives as that person, with their memory and permissions.');
    } finally {
        closeDatabase();
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
