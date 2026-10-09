/**
 * pnpm kismatik:import <result.json> [chat-id]
 *
 * Loads a Telegram Desktop JSON export into KISMATIK memory. Safe to rerun:
 * messages already stored are skipped. Embedding and the wiki digest happen
 * later, in the running bot.
 */

import { importTelegramExportFile } from '../kismatik/import';
import { closeKismatikDb } from '../kismatik/store';

const [file, chatId] = process.argv.slice(2);
if (!file) {
    console.error('Usage: pnpm kismatik:import <result.json> [chat-id]');
    process.exit(1);
}

try {
    const result = importTelegramExportFile(file, chatId);
    console.log(
        `Imported ${result.imported} message(s) into ${result.chatId}; ${result.duplicates} already stored, ${result.skipped} skipped.`
    );
} finally {
    closeKismatikDb();
}
