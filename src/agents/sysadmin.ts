import { logEvent } from '../db';
import { notifyPrimaryHousehold } from '../channels/runtime';
import { processWithOllama } from '../core/ollama';
import { createRuntimeBackup } from '../core/runtime-backup';

const JEEVES_ALERT_SYSTEM =
    'You are Jeeves. Rephrase the alert briefly and elegantly in 1-2 sentences. Preserve all facts and numbers exactly. No markdown.';

async function formatAlert(template: string): Promise<string> {
    try {
        const result = await processWithOllama(
            `Rephrase this alert in Jeeves style: "${template}"`,
            JEEVES_ALERT_SYSTEM
        );
        return result.text?.trim() || template;
    } catch {
        return template;
    }
}

const alertCooldowns = new Map<string, number>();
const COOLDOWN_DEFAULT = 2 * 60 * 60 * 1000;

function canAlert(key: string, cooldownMs = COOLDOWN_DEFAULT): boolean {
    const last = alertCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldownMs) return false;
    alertCooldowns.set(key, Date.now());
    return true;
}

export async function runSystemHealthCheck() {
    try {
        const { getSystemMetrics } = require('../core/healthcheck');
        const m = getSystemMetrics();

        if (m.tempC > 50 && canAlert('temp')) {
            logEvent('system_health', { alert: 'high_temp', temp: m.tempC });
            await notifyPrimaryHousehold(
                await formatAlert(`CPU temperature is ${m.tempC.toFixed(1)}°C. Better ventilation would be wise.`)
            );
        }

        if (m.ramPercent > 85 && canAlert('ram')) {
            logEvent('system_health', { alert: 'high_ram', used: m.ramUsedMB, total: m.ramTotalMB });
            await notifyPrimaryHousehold(
                await formatAlert(
                    `RAM usage is ${m.ramPercent}% (${m.ramUsedMB}/${m.ramTotalMB} MB). This merits a look.`
                )
            );
        }

        if (m.diskPercent > 90 && canAlert('disk')) {
            logEvent('system_health', { alert: 'disk_full', usage: m.diskPercent });
            await notifyPrimaryHousehold(
                await formatAlert(
                    `Disk usage has reached ${m.diskPercent}%. Some housekeeping in storage would be prudent.`
                )
            );
        }

        if (m.swapTotalMB > 0 && m.swapUsedMB > m.swapTotalMB * 0.5 && canAlert('swap')) {
            logEvent('system_health', { alert: 'high_swap', used: m.swapUsedMB, total: m.swapTotalMB });
            await notifyPrimaryHousehold(
                await formatAlert(
                    `Swap usage is at ${Math.round((m.swapUsedMB / m.swapTotalMB) * 100)}% (${m.swapUsedMB}/${m.swapTotalMB} MB). The system is under memory pressure.`
                )
            );
        }
    } catch (err: any) {
        console.error('[SYSADMIN] Health check error:', err.message);
    }
}

export async function runDatabaseBackup() {
    try {
        const backup = await createRuntimeBackup('scheduled');
        console.log(`[BACKUP] Runtime backup saved to ${backup.id}`);
        logEvent('db_backup', { id: backup.id, kind: backup.kind, file_count: backup.file_count });
    } catch (err: any) {
        console.error('[BACKUP] Database backup failed:', err.message);
        logEvent('db_backup_failed', { error: err.message });
        await notifyPrimaryHousehold(`Database backup failed: ${err.message}`);
    }
}
