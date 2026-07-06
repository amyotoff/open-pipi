import cron from 'node-cron';
import { runSystemHealthCheck, runDatabaseBackup } from './agents/sysadmin';
import { checkReminders } from './agents/reminders';
import { runHeartbeat } from './core/healthcheck';
import { checkTaskDeadlines, ensureDefaultAssistantTasksForActiveSpaces, registerScheduledTasks } from './core/tasks';
import { cleanupSystemMetricsHistory, cleanupToolExecutionLogs, cleanupToolLogs } from './db';

const TZ = process.env.TZ ? { timezone: process.env.TZ } : {};

export function startTaskScheduler() {
    console.log('[SCHEDULER] Starting cron jobs...');

    const reseededSpaces = ensureDefaultAssistantTasksForActiveSpaces();
    console.log(`[SCHEDULER] Reseeded default assistant tasks for ${reseededSpaces} active space(s).`);

    cron.schedule(
        '* * * * *',
        async () => {
            try {
                await runHeartbeat();
            } catch (e) {
                console.error('[CRON] Heartbeat error:', e);
            }
        },
        TZ
    );

    cron.schedule(
        '*/30 * * * *',
        async () => {
            try {
                await runSystemHealthCheck();
            } catch (e) {
                console.error('[CRON] Health check error:', e);
            }
        },
        TZ
    );

    cron.schedule(
        '0 3 * * *',
        async () => {
            try {
                await runDatabaseBackup();
            } catch (e) {
                console.error('[CRON] Database backup error:', e);
            }
        },
        TZ
    );

    cron.schedule(
        '30 3 * * *',
        async () => {
            try {
                const deletedTelemetry = cleanupSystemMetricsHistory(14);
                if (deletedTelemetry > 0) {
                    console.log(`[CRON] Cleaned up ${deletedTelemetry} old telemetry sample(s).`);
                }

                const deletedToolLogs = cleanupToolExecutionLogs(30);
                if (deletedToolLogs > 0) {
                    console.log(`[CRON] Cleaned up ${deletedToolLogs} old tool execution log(s).`);
                }

                const deletedCallLogs = cleanupToolLogs(30);
                if (deletedCallLogs > 0) {
                    console.log(`[CRON] Cleaned up ${deletedCallLogs} old tool call log(s).`);
                }
            } catch (e) {
                console.error('[CRON] Retention cleanup error:', e);
            }
        },
        TZ
    );

    cron.schedule(
        '* * * * *',
        async () => {
            try {
                await checkReminders();
            } catch (e) {
                console.error('[CRON] Reminders check error:', e);
            }
        },
        TZ
    );

    cron.schedule(
        '*/30 * * * *',
        async () => {
            try {
                await checkTaskDeadlines();
            } catch (e) {
                console.error('[CRON] Task deadline check error:', e);
            }
        },
        TZ
    );

    const registeredTasks = registerScheduledTasks();
    console.log(`[SCHEDULER] Registered ${registeredTasks} assistant task(s).`);

    console.log('[SCHEDULER] All cron jobs registered.');
}
