import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadHealthcheck(runtimePlatform: 'raspberry_pi' | 'generic' = 'raspberry_pi') {
    vi.resetModules();
    const logEvent = vi.fn();
    const storeSystemMetricsSample = vi.fn();
    const notifyPrimaryHousehold = vi.fn();
    const runCommand = vi.fn(async (command: string) => {
        if (command.includes('df -h /')) return 'rootfs 30G 10G 20G 33% /';
        if (command.includes('/sys/class/thermal')) return '42000';
        if (command.includes('free -m | grep Mem')) return 'Mem: 2048 512 1536 0 0 0';
        if (command.includes('free -m | grep Swap')) return 'Swap: 256 64 192';
        if (command.includes('uptime -p')) return 'up 1 hour';
        if (command.includes('dmesg -l crit,alert,emerg')) return '';
        if (command.includes('vcgencmd get_throttled')) return 'throttled=0x0';
        if (command.includes('/sys/block/mmcblk0/stat')) return '1 2 3 4 5 6 7 8 9 10 11';
        if (command.includes('grep -i "mmc')) return '';
        return '';
    });
    const fetchMock = vi.fn(async (url: string) => ({ ok: !url.includes('fail') }));

    vi.doMock('../db', () => ({
        logEvent,
        storeSystemMetricsSample,
        getDailyTokenCost: () => ({ input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 }),
    }));
    vi.doMock('../channels/runtime', () => ({ notifyPrimaryHousehold }));
    vi.doMock('../config', () => ({
        OLLAMA_URL: 'http://ollama',
        OLLAMA_MODEL: 'test-model',
        RUNTIME_PLATFORM: runtimePlatform,
    }));
    vi.doMock('../utils/shell', () => ({ runCommand }));
    global.fetch = fetchMock as any;

    const mod = await import('./healthcheck');
    return { ...mod, logEvent, storeSystemMetricsSample, notifyPrimaryHousehold, runCommand, fetchMock };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/healthcheck', () => {
    it('toggles the kill switch and reports blocking state', async () => {
        const mod = await loadHealthcheck();

        expect(mod.guardLLMCall()).toBeNull();
        mod.setKillSwitch(true, 'test');
        expect(mod.isKillSwitchActive()).toBe(true);
        expect(mod.guardLLMCall()).toContain('Kill switch');
        expect(mod.notifyPrimaryHousehold).toHaveBeenCalled();
    });

    it('summarizes current health state', async () => {
        const mod = await loadHealthcheck();
        const summary = mod.getHealthSummary();

        expect(summary).toContain('Gemini');
        expect(summary).toContain('Ollama');
    });

    it('runs heartbeat and updates cached metrics', async () => {
        const mod = await loadHealthcheck();
        await mod.runHeartbeat();

        const metrics = mod.getSystemMetrics();
        expect(metrics.tempC).toBe(42);
        expect(metrics.ramPercent).toBe(25);
        expect(metrics.diskPercent).toBe(33);
        expect(metrics.updatedAt).toBeGreaterThan(0);
        expect(mod.storeSystemMetricsSample).toHaveBeenCalledTimes(1);
    });

    it('marks Gemini down after repeated failures and can recover', async () => {
        const mod = await loadHealthcheck();

        mod.reportGeminiResult(false);
        mod.reportGeminiResult(false);
        mod.reportGeminiResult(false);
        expect(mod.getHealthSummary()).toContain('Gemini: DOWN');

        mod.reportGeminiResult(true);
        mod.reportGeminiResult(true);
        expect(mod.getHealthSummary()).toContain('Gemini: OK');
    });

    it('skips Pi-specific checks on generic hosts', async () => {
        const mod = await loadHealthcheck('generic');
        await mod.runHeartbeat();

        expect(mod.runCommand).not.toHaveBeenCalledWith(
            expect.stringContaining('vcgencmd get_throttled'),
            expect.anything()
        );
        expect(mod.runCommand).not.toHaveBeenCalledWith(
            expect.stringContaining('/sys/block/mmcblk0/stat'),
            expect.anything()
        );
        expect(mod.getHealthSummary()).toContain('Platform: generic');
        expect(mod.getHealthSummary()).toContain('Pi-specific telemetry: disabled');
    });

    describe('the daily spend ceiling', () => {
        const ORIGINAL_ENV = { ...process.env };

        afterEach(() => {
            process.env = { ...ORIGINAL_ENV };
        });

        it('defaults to $3 when nothing is configured', async () => {
            delete process.env.PIPI_DAILY_COST_LIMIT_USD;
            expect((await loadHealthcheck()).DAILY_COST_LIMIT).toBe(3.0);
        });

        it('takes the configured limit', async () => {
            process.env.PIPI_DAILY_COST_LIMIT_USD = '25';
            expect((await loadHealthcheck()).DAILY_COST_LIMIT).toBe(25);
        });

        it('keeps the ceiling when the value is nonsense', async () => {
            // A typo must not silently remove the spend limit — that is the one
            // failure mode this guard exists to prevent.
            for (const value of ['', 'lots', '-5', '0']) {
                process.env.PIPI_DAILY_COST_LIMIT_USD = value;
                expect((await loadHealthcheck()).DAILY_COST_LIMIT, value).toBe(3.0);
            }
        });
    });
});
