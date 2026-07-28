import { OLLAMA_URL, RUNTIME_PLATFORM } from '../config';
import { logEvent, getDailyTokenCost, storeSystemMetricsSample } from '../db';
import { notifyPrimaryHousehold } from '../channels/runtime';
import { runCommand } from '../utils/shell';

// ==========================================
// Health State
// ==========================================

interface HealthState {
    ollama: boolean;
    gemini: boolean;
    internet: boolean;
    disk_ok: boolean;
    temp_ok: boolean;
    ram_ok: boolean;
    syserr_ok: boolean;
    throttle_ok: boolean; // no undervoltage/throttling
    sdcard_ok: boolean; // no I/O errors on SD card
    killswitch: boolean; // manual or auto kill switch
}

const state: HealthState = {
    ollama: false,
    gemini: true, // assume ok until proven otherwise
    internet: true,
    disk_ok: true,
    temp_ok: true,
    ram_ok: true,
    syserr_ok: true,
    throttle_ok: true,
    sdcard_ok: true,
    killswitch: false,
};

// Cached raw metrics (updated every heartbeat, read by ops/telegram/sysadmin)
export interface SystemMetrics {
    tempC: number;
    ramUsedMB: number;
    ramTotalMB: number;
    ramPercent: number;
    swapUsedMB: number;
    swapTotalMB: number;
    diskPercent: number;
    diskUsed: string;
    diskTotal: string;
    uptime: string;
    throttleHex: string; // raw vcgencmd output, e.g. "0x0"
    updatedAt: number;
}

const metrics: SystemMetrics = {
    tempC: 0,
    ramUsedMB: 0,
    ramTotalMB: 0,
    ramPercent: 0,
    swapUsedMB: 0,
    swapTotalMB: 0,
    diskPercent: 0,
    diskUsed: '?',
    diskTotal: '?',
    uptime: '?',
    throttleHex: '0x0',
    updatedAt: 0,
};

// Consecutive failure/success counters for hysteresis
const failures: Record<string, number> = {};
const successes: Record<string, number> = {};

const FAIL_THRESHOLD = 3; // 3 fails → mark down
const RECOVER_THRESHOLD = 2; // 2 successes → mark up

// Kill switch config
/**
 * Spend per day, after which the killswitch trips and the assistant stops
 * answering until it is cleared.
 *
 * Configurable because $3 is a sensible default for a household on a Pi and a
 * useless one for anything else, and the alternative was editing this file.
 * Read once at startup; a bad or missing value keeps the default rather than
 * removing the ceiling.
 */
export const DAILY_COST_LIMIT = readDailyCostLimit();

function readDailyCostLimit(): number {
    const raw = Number(process.env.PIPI_DAILY_COST_LIMIT_USD);
    return Number.isFinite(raw) && raw > 0 ? raw : 3.0;
}
const HOURLY_CALLS_LIMIT = 120; // 120 LLM calls/hour → something is looping
let hourlyCallCount = 0;
let hourlyResetTime = Date.now();
let lastTelemetrySampleAt = 0;

// ==========================================
// Public API
// ==========================================

export function getHealthState(): HealthState {
    return { ...state };
}

/** Cached system metrics — updated every heartbeat (60s). No shell calls needed. */
export function getSystemMetrics(): SystemMetrics {
    return { ...metrics };
}

export function isKillSwitchActive(): boolean {
    return state.killswitch;
}

export function setKillSwitch(active: boolean, reason?: string): void {
    const was = state.killswitch;
    state.killswitch = active;
    if (active && !was) {
        console.warn(`[KILLSWITCH] ACTIVATED: ${reason || 'manual'}`);
        logEvent('killswitch', { action: 'activated', reason: reason || 'manual' });
        notifyPrimaryHousehold(
            `KILLSWITCH активирован: ${reason || 'вручную'}. LLM-вызовы заблокированы. Используй /killswitch off чтобы снять.`
        );
    } else if (!active && was) {
        console.log(`[KILLSWITCH] Deactivated`);
        logEvent('killswitch', { action: 'deactivated' });
        notifyPrimaryHousehold(`KILLSWITCH снят. Бот работает в штатном режиме.`);
    }
}

/** Call before every LLM request. Returns reason string if blocked, null if ok. */
export function guardLLMCall(): string | null {
    if (state.killswitch) {
        return 'Kill switch активен. LLM-вызовы заблокированы.';
    }

    // Hourly rate check
    const now = Date.now();
    if (now - hourlyResetTime > 3600_000) {
        hourlyCallCount = 0;
        hourlyResetTime = now;
    }
    hourlyCallCount++;

    if (hourlyCallCount > HOURLY_CALLS_LIMIT) {
        setKillSwitch(true, `Превышен лимит: ${HOURLY_CALLS_LIMIT} LLM-вызовов/час. Возможен цикл.`);
        return 'Auto-killswitch: слишком много вызовов за час.';
    }

    // Daily cost check
    try {
        const daily = getDailyTokenCost();
        if (daily.cost_usd >= DAILY_COST_LIMIT) {
            setKillSwitch(true, `Дневной лимит $${DAILY_COST_LIMIT} превышен ($${daily.cost_usd.toFixed(2)})`);
            return `Auto-killswitch: потрачено $${daily.cost_usd.toFixed(2)} за день.`;
        }
    } catch {}

    return null;
}

export function isGeminiAvailable(): boolean {
    return state.gemini && !state.killswitch;
}

export function isOllamaHealthy(): boolean {
    return state.ollama;
}

export function isInternetAvailable(): boolean {
    return state.internet;
}

/** Report a Gemini call result for tracking */
export function reportGeminiResult(ok: boolean): void {
    updateComponent('gemini', ok);
}

export function getHealthSummary(): string {
    const lines: string[] = [];
    lines.push(`Platform: ${RUNTIME_PLATFORM}`);
    lines.push(`Gemini: ${state.gemini ? 'OK' : 'DOWN'}`);
    lines.push(`Ollama: ${state.ollama ? 'OK' : 'DOWN'}`);
    lines.push(`Интернет: ${state.internet ? 'OK' : 'DOWN'}`);
    lines.push(`Диск: ${state.disk_ok ? 'OK' : 'КРИТИЧНО'}`);
    lines.push(`Температура: ${state.temp_ok ? 'OK' : 'ВЫСОКАЯ'}`);
    lines.push(`RAM: ${state.ram_ok ? 'OK' : 'ПЕРЕГРУЗКА'}`);
    lines.push(`Ошибки ОС: ${state.syserr_ok ? 'НЕТ' : 'ОБНАРУЖЕНЫ'}`);
    if (RUNTIME_PLATFORM === 'raspberry_pi') {
        lines.push(`Питание: ${state.throttle_ok ? 'OK' : 'ПРОБЛЕМА (undervoltage/throttle)'}`);
        lines.push(`SD-карта: ${state.sdcard_ok ? 'OK' : 'ОШИБКИ I/O'}`);
    } else {
        lines.push('Pi-specific telemetry: disabled');
    }
    if (state.killswitch) lines.push('KILLSWITCH: АКТИВЕН');

    try {
        const daily = getDailyTokenCost();
        lines.push(`Токены сегодня: $${daily.cost_usd.toFixed(2)} (${daily.calls} вызовов)`);
    } catch {}

    return lines.join('\n');
}

// ==========================================
// Heartbeat Checks
// ==========================================

function updateComponent(name: string, ok: boolean): void {
    const key = name as keyof HealthState;
    if (!failures[name]) failures[name] = 0;
    if (!successes[name]) successes[name] = 0;

    if (ok) {
        successes[name]++;
        failures[name] = 0;
        if (!state[key] && successes[name] >= RECOVER_THRESHOLD) {
            (state as any)[key] = true;
            console.log(`[HEALTH] ${name} recovered`);
            logEvent('health_change', { component: name, status: 'recovered' });
            // Don't notify for Ollama recovery specifically, it's too noisy
            if (name !== 'ollama') {
                notifyPrimaryHousehold(`${name} восстановлен.`);
            }
        }
    } else {
        failures[name]++;
        successes[name] = 0;
        if (state[key] && failures[name] >= FAIL_THRESHOLD) {
            (state as any)[key] = false;
            console.warn(`[HEALTH] ${name} marked DOWN (${failures[name]} consecutive failures)`);
            logEvent('health_change', { component: name, status: 'down' });
            let alertMsg = `${name} недоступен (${failures[name]} ошибок подряд).`;
            if (name === 'temp_ok')
                alertMsg = '🔥 Позвольте заметить, температура процессора критически высока (>75°C).';
            if (name === 'disk_ok')
                alertMsg = '💾 Позвольте заметить, диск заполнен более чем на 90%. Возможны сбои ОС.';
            if (name === 'ram_ok') alertMsg = '🧠 Позвольте заметить, оперативная память перегружена (>90%).';
            if (name === 'syserr_ok')
                alertMsg = '⚠️ Позвольте заметить, мы зафиксировали критические системные ошибки через dmesg.';
            if (name === 'throttle_ok')
                alertMsg =
                    '⚡ Позвольте заметить, обнаружены проблемы с питанием (undervoltage/throttling). Проверьте блок питания.';
            if (name === 'sdcard_ok')
                alertMsg =
                    '💾 Позвольте заметить, обнаружены ошибки I/O на SD-карте. Рекомендую проверить или заменить карту.';
            notifyPrimaryHousehold(alertMsg);
        }
    }
}

async function checkOllama(): Promise<void> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
        clearTimeout(timeout);
        updateComponent('ollama', res.ok);
    } catch {
        updateComponent('ollama', false);
    }
}

async function checkInternet(): Promise<void> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch('https://dns.google/resolve?name=google.com&type=A', { signal: controller.signal });
        clearTimeout(timeout);
        updateComponent('internet', res.ok);
    } catch {
        updateComponent('internet', false);
    }
}

async function checkDisk(): Promise<void> {
    try {
        const raw = await runCommand('df -h / | tail -1', 5000);
        const parts = raw.trim().split(/\s+/);
        const pctStr = (parts[4] || '0').replace('%', '');
        const pct = parseInt(pctStr);
        metrics.diskPercent = pct;
        metrics.diskUsed = parts[2] || '?';
        metrics.diskTotal = parts[1] || '?';
        updateComponent('disk_ok', pct < 90);
    } catch {
        // Can't check = assume ok
    }
}

async function checkTemp(): Promise<void> {
    try {
        const raw = await runCommand('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "0"', 3000);
        const tempC = parseInt(raw) / 1000;
        metrics.tempC = tempC;
        updateComponent('temp_ok', tempC < 75);
    } catch {
        // Can't check = assume ok
    }
}

async function checkRam(): Promise<void> {
    try {
        const memRaw = await runCommand('free -m | grep Mem', 3000);
        const memParts = memRaw.trim().split(/\s+/);
        const used = parseInt(memParts[2] || '0');
        const total = parseInt(memParts[1] || '1');
        metrics.ramUsedMB = used;
        metrics.ramTotalMB = total;
        metrics.ramPercent = Math.round((used / total) * 100);
        updateComponent('ram_ok', metrics.ramPercent < 90);
    } catch {}

    // Swap check
    try {
        const swapRaw = await runCommand('free -m | grep Swap', 3000);
        const swapParts = swapRaw.trim().split(/\s+/);
        metrics.swapUsedMB = parseInt(swapParts[2] || '0');
        metrics.swapTotalMB = parseInt(swapParts[1] || '0');
    } catch {}
}

async function checkUptime(): Promise<void> {
    try {
        metrics.uptime = await runCommand('uptime -p 2>/dev/null || uptime', 3000);
    } catch {}
}

async function checkSysErr(): Promise<void> {
    try {
        const raw = await runCommand('dmesg -l crit,alert,emerg 2>/dev/null', 3000);
        updateComponent('syserr_ok', raw.trim().length === 0);
    } catch {
        // In unprivileged containers dmesg might fail, assume OK.
    }
}

async function checkThrottled(): Promise<void> {
    try {
        const raw = await runCommand('vcgencmd get_throttled 2>/dev/null || echo "throttled=0x0"', 3000);
        const hex = raw.match(/throttled=(0x[0-9a-fA-F]+)/)?.[1] || '0x0';
        metrics.throttleHex = hex;
        const val = parseInt(hex, 16);
        // bit 0 = under-voltage now, bit 1 = arm freq capped now, bit 2 = currently throttled
        // bit 16 = under-voltage occurred, bit 17 = arm freq capped occurred, bit 18 = throttling occurred
        const hasIssue = (val & 0x7) !== 0; // current problems only
        updateComponent('throttle_ok', !hasIssue);
    } catch {}
}

async function checkSdCard(): Promise<void> {
    try {
        // Read I/O error counters from block device stats
        const raw = await runCommand('cat /sys/block/mmcblk0/stat 2>/dev/null || echo ""', 3000);
        if (!raw.trim()) return; // no mmcblk0 = not running on Pi with SD card
        // Fields: reads_completed reads_merged sectors_read ms_reading writes_completed writes_merged sectors_written ms_writing ios_in_progress ms_io weighted_ms_io discards discards_merged sectors_discarded ms_discard flush_requests ms_flush
        // Field 10 (0-indexed 9) = ios_in_progress — if stuck, indicates I/O error
        // Also check dmesg for mmc errors
        const mmcErrors = await runCommand(
            'dmesg 2>/dev/null | grep -i "mmc.*error\\|mmcblk.*failed\\|I/O error" | tail -3 || echo ""',
            3000
        );
        updateComponent('sdcard_ok', mmcErrors.trim().length === 0);
    } catch {}
}

/** Run full heartbeat. Called by cron every 60s. */
export async function runHeartbeat(): Promise<void> {
    const checks = [checkOllama(), checkInternet(), checkDisk(), checkTemp(), checkRam(), checkUptime(), checkSysErr()];

    if (RUNTIME_PLATFORM === 'raspberry_pi') {
        checks.push(checkThrottled(), checkSdCard());
    } else {
        state.throttle_ok = true;
        state.sdcard_ok = true;
        metrics.throttleHex = 'n/a';
    }

    await Promise.all(checks);
    const now = Date.now();
    metrics.updatedAt = now;

    if (now - lastTelemetrySampleAt >= 5 * 60 * 1000) {
        storeSystemMetricsSample({
            timestamp: new Date(now).toISOString(),
            temp_c: metrics.tempC,
            ram_percent: metrics.ramPercent,
            swap_used_mb: metrics.swapUsedMB,
            disk_percent: metrics.diskPercent,
            throttle_hex: metrics.throttleHex,
            internet_ok: state.internet ? 1 : 0,
            ollama_ok: state.ollama ? 1 : 0,
        });
        lastTelemetrySampleAt = now;
    }
}
