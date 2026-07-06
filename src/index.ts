import { initializeOpenTelemetry, shutdownOpenTelemetry } from './observability';

const APP_VERSION = process.env.npm_package_version || '2.5.0';

let shuttingDown = false;
let closeDatabaseRef: (() => void) | null = null;
let closeApiServerRef: (() => Promise<void>) | null = null;

type OptionalModuleLoader = {
    label: string;
    enabled: boolean;
    importPath: string;
    packageNames: string[];
};

function isMissingOptionalDependency(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
    return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

async function loadOptionalModules(loaders: OptionalModuleLoader[]): Promise<void> {
    for (const loader of loaders) {
        if (!loader.enabled) continue;

        try {
            await import(loader.importPath);
        } catch (error) {
            if (isMissingOptionalDependency(error)) {
                const packageList = loader.packageNames.join(', ');
                throw new Error(
                    `${loader.label} support is enabled by environment, but optional dependencies are missing: ${packageList}. Run "pnpm install" without "--no-optional", or add those packages explicitly.`,
                    { cause: error }
                );
            }
            throw error;
        }
    }
}

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[BOOT] Received ${signal}, shutting down gracefully...`);

    try {
        closeDatabaseRef?.();
    } catch (error) {
        console.error('[BOOT] Failed to close database cleanly:', error);
    }

    try {
        await closeApiServerRef?.();
    } catch (error) {
        console.error('[BOOT] Failed to close API server cleanly:', error);
    }

    try {
        await shutdownOpenTelemetry();
    } catch (error) {
        console.error('[BOOT] Failed to flush OpenTelemetry cleanly:', error);
    } finally {
        process.exit(0);
    }
}

async function bootstrap() {
    console.log('Bootstrapping Open PiPi...');
    await initializeOpenTelemetry({
        serviceName: 'open-pipi-runtime',
        serviceNamespace: 'open-pipi',
        serviceVersion: APP_VERSION,
    });

    const config = await import('./config');
    config.assertSafeStartupConfig();
    config.validateCriticalConfig();

    await loadOptionalModules([
        {
            label: 'WhatsApp',
            enabled: process.env.WHATSAPP_ENABLED === 'true',
            importPath: './channels/whatsapp',
            packageNames: ['@whiskeysockets/baileys', '@hapi/boom'],
        },
        {
            label: 'Discord',
            enabled: Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID),
            importPath: './channels/discord',
            packageNames: ['discord.js'],
        },
        {
            label: 'Gmail',
            enabled: Boolean(process.env.CONCIERGE_SMTP_HOST && process.env.CONCIERGE_SMTP_USER),
            importPath: './channels/gmail',
            packageNames: ['nodemailer'],
        },
    ]);

    const [
        db,
        telegram,
        channelRegistry,
        runtime,
        router,
        skillsRegistry,
        scheduler,
        memoryBackfill,
        runtimeBackup,
        api,
    ] = await Promise.all([
        import('./db'),
        import('./channels/telegram'),
        import('./channels/_registry'),
        import('./channels/runtime'),
        import('./router'),
        import('./skills/_registry'),
        import('./task-scheduler'),
        import('./core/memory-backfill'),
        import('./core/runtime-backup'),
        import('./api'),
    ]);

    closeDatabaseRef = db.closeDatabase;

    db.initDatabase();
    console.log('Database initialized.');

    const googleOAuth = await import('./core/google-oauth');
    googleOAuth.initGoogleOAuthMigrations();
    googleOAuth.onGoogleOAuthSuccess(async (spaceId) => {
        const chatId = spaceId.startsWith('telegram:') ? spaceId.slice('telegram:'.length) : null;
        if (chatId) {
            const { sendMessageToChat } = await import('./channels/telegram');
            await sendMessageToChat(
                chatId,
                'Google Drive connected! You can now use Google Docs and Sheets tools.'
            ).catch(() => {});
        }
    });

    await channelRegistry.connectAll();

    await skillsRegistry.initAllSkills();
    runtime.setIncomingChannelHandler(router.handleIncomingChannelMessage);

    const backfill = memoryBackfill.backfillLegacyMemory();
    if (backfill.resident_notes || backfill.house_diary || backfill.daily_insights) {
        console.log(
            `[BOOT] Legacy memory backfilled: resident_notes=${backfill.resident_notes}, house_diary=${backfill.house_diary}, daily_insights=${backfill.daily_insights}`
        );
    }

    scheduler.startTaskScheduler();
    await api.startApiServer();
    closeApiServerRef = () => api.stopApiServer();

    telegram.setMessageHandler(router.handleIncomingMessage);
    telegram.startTelegramBot();

    db.logEvent('reboot', { reason: 'startup', timestamp: new Date().toISOString() });
    try {
        const restorePoint = await runtimeBackup.ensureHealthyRestorePoint();
        console.log(`[BOOT] Healthy restore point ready: ${restorePoint.id}`);
    } catch (error) {
        console.error('[BOOT] Failed to refresh healthy restore point:', error);
    }
    const startupMsg = 'Open PiPi is on air';
    console.log(startupMsg);
    telegram.notifyHousehold(startupMsg);
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

bootstrap().catch(async (error) => {
    console.error('Fatal error:', error);
    try {
        await shutdownOpenTelemetry();
    } finally {
        process.exit(1);
    }
});
