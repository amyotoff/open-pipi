/**
 * pnpm kismatik:import <result.json> [chat-id] [channel-username]
 *
 * Loads a Telegram Desktop JSON export into KISMATIK memory. Safe to rerun:
 * messages already stored are skipped. For a channel export, pass the channel's
 * username so posts get t.me links. Embedding and the wiki digest happen
 * later, in the running bot.
 */

import { importTelegramExportFile } from '../kismatik/import';
import { closeKismatikDb } from '../kismatik/store';

const [file, chatId, username] = process.argv.slice(2);
if (!file) {
    console.error('Usage: pnpm kismatik:import <result.json> [chat-id] [channel-username]');
    process.exit(1);
}

try {
    const result = importTelegramExportFile(file, chatId || undefined, { username });
    console.log(
        `Imported ${result.imported} message(s) into ${result.chatId}; ${result.duplicates} already stored, ${result.skipped} skipped.`
    );
} finally {
    closeKismatikDb();
}
