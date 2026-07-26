import { initializeOpenTelemetry, shutdownOpenTelemetry } from './observability';

const APP_VERSION = process.env.npm_package_version || '2.5.0';

let shuttingDown = false;
let closeDatabaseRef: (() => void) | null = null;
let closeApiServerRef: (() => Promise<void>) | null = null;
let closeTransportsRef: (() => Promise<void>) | null = null;
let closeDeliveryWorkerRef: (() => void) | null = null;

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[BOOT] Received ${signal}, shutting down gracefully...`);

    try {
        // Stop accepting new work before the transports go away, so the worker
        // never claims an entry it has no way to deliver.
        closeDeliveryWorkerRef?.();
    } catch (error) {
        console.error('[BOOT] Failed to stop the delivery worker cleanly:', error);
    }

    try {
        await closeTransportsRef?.();
    } catch (error) {
        console.error('[BOOT] Failed to stop transports cleanly:', error);
    }

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

    const channelLoader = await import('./channels/_loader');
    await channelLoader.loadOptionalChannels();

    const [
        db,
        telegramAdapter,
        transportRegistry,
        gateway,
        deliveryWorker,
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
        import('./transports/telegram/adapter'),
        import('./transports/registry'),
        import('./gateway/message-gateway'),
        import('./gateway/delivery-worker'),
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
        // Addressed by space, not by picking a chat id out of the space id.
        // The space knows which endpoint reaches it; this works for whichever
        // transport the person actually used.
        await runtime
            .sendSpaceMessage(spaceId, 'Google Drive connected! You can now use Google Docs and Sheets tools.')
            .catch(() => {});
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

    const topology = db.getTransportTopologyReport();
    console.log(
        `[BOOT] Transport topology: ${topology.bindings} binding(s) for ${topology.spaces} space(s), ${topology.identities} identity(ies) for ${topology.participants} participant(s)`
    );
    if (topology.spaces_without_binding.length > 0) {
        console.warn(
            `[BOOT] ${topology.spaces_without_binding.length} space(s) have no transport binding and fall back to legacy routing: ${topology.spaces_without_binding.join(', ')}`
        );
    }
    if (topology.participants_without_identity.length > 0) {
        console.warn(
            `[BOOT] ${topology.participants_without_identity.length} participant(s) have no transport identity: ${topology.participants_without_identity.join(', ')}`
        );
    }

    scheduler.startTaskScheduler();
    await api.startApiServer();
    closeApiServerRef = () => api.stopApiServer();

    // Telegram is required: without it there is no assistant to run, so a
    // failure here should stop the boot rather than leave a silent runtime.
    transportRegistry.registerTransport(new telegramAdapter.TelegramTransportAdapter(), { required: true });
    closeTransportsRef = () => transportRegistry.stopAllTransports();
    await transportRegistry.startAllTransports({ messageGateway: { handleIncoming: gateway.handleIncoming } });

    // Started after the transports, so the first drain has somewhere to send.
    // Anything queued before the last shutdown goes out now.
    deliveryWorker.startDeliveryWorker();
    closeDeliveryWorkerRef = deliveryWorker.stopDeliveryWorker;

    db.logEvent('reboot', { reason: 'startup', timestamp: new Date().toISOString() });
    try {
        const restorePoint = await runtimeBackup.ensureHealthyRestorePoint();
        console.log(`[BOOT] Healthy restore point ready: ${restorePoint.id}`);
    } catch (error) {
        console.error('[BOOT] Failed to refresh healthy restore point:', error);
    }
    const { notifyPrimaryHousehold } = runtime;
    const startupMsg = 'Open PiPi is on air';
    console.log(startupMsg);
    await notifyPrimaryHousehold(startupMsg);
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
