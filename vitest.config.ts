import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            exclude: [
                'src/test-helpers/**',
                // Entry points and infrastructure that require live services
                'src/index.ts',
                'src/sandboxd.ts',
                'src/task-scheduler.ts',
                // Channel adapters (require Telegram/Discord/WhatsApp/IMAP connections)
                'src/channels/telegram.ts',
                'src/channels/telegram-bot.ts',
                'src/channels/telegram-commands.ts',
                'src/channels/telegram-send.ts',
                'src/channels/discord.ts',
                'src/channels/whatsapp.ts',
                'src/channels/gmail.ts',
                'src/channels/_registry.ts',
                'src/channels/runtime.ts',
                // Modules that require external APIs or sidecar processes
                'src/core/llm.ts',
                'src/core/sandbox-client.ts',
                'src/core/coretoolbox.ts',
                'src/utils/search.ts',
                'src/utils/failure-monitor.ts',
                // CLI scripts (require live runtime environment)
                'src/scripts/**',
                // Tests materialize immutable pack snapshots under temporary DATA_DIR roots.
                '**/space-behavior/**',
            ],
            thresholds: {
                statements: 77,
                functions: 77,
                lines: 77,
                // TODO: raise branch coverage once adapter seams have isolated tests.
                branches: 55,
            },
        },
    },
});
