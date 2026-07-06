import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadShellModule() {
    vi.resetModules();

    const exec = vi.fn((command: string, optionsOrCallback: any, maybeCallback?: any) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        if (command === 'sleep 10') {
            callback(new Error('timeout'));
            return;
        }
        callback(null, ` ${command} `, '');
    });
    (exec as any)[Symbol.for('nodejs.util.promisify.custom')] = (command: string) => {
        if (command === 'sleep 10') {
            return Promise.reject(new Error('timeout'));
        }
        if (command === 'ping 127.0.0.1') {
            return Promise.reject({ stdout: 'partial ping output' });
        }
        return Promise.resolve({ stdout: ` ${command} `, stderr: '' });
    };

    const execFile = vi.fn((file: string, args: string[], options: any, callback: any) => {
        if (file === 'nslookup') {
            callback(Object.assign(new Error('lookup failed'), { code: 1 }), '', '');
            return;
        }
        if (file === 'dig') {
            callback(null, '93.184.216.34', '');
            return;
        }
        if (file === 'arp') {
            callback(Object.assign(new Error('arp missing'), { code: 127 }), '', '');
            return;
        }
        if (file === 'ip') {
            callback(null, '192.168.1.2 dev wlan0', '');
            return;
        }
        if (file === 'ss' && args.join(' ') === '-tnp state established') {
            callback(Object.assign(new Error('ss failed'), { code: 1 }), '', '');
            return;
        }
        if (file === 'ss' && args.join(' ') === '-tnap') {
            callback(Object.assign(new Error('ss failed'), { code: 1 }), '', '');
            return;
        }
        if (file === 'iwconfig') {
            callback(null, 'wlan0  IEEE 802.11\nno wireless extensions', '');
            return;
        }
        if (file === 'docker' && args[0] === 'restart') {
            callback(null, 'restarted', '');
            return;
        }
        if (file === 'timeout') {
            callback(Object.assign(new Error('timed out'), { code: 124 }), '', 'capture complete');
            return;
        }
        if (file === 'journalctl') {
            callback(Object.assign(new Error('permission denied'), { code: 1 }), '', 'permission denied');
            return;
        }
        callback(null, `${file} ${args.join(' ')}`.trim(), '');
    });

    vi.doMock('child_process', () => ({ exec, execFile }));

    const mod = await import('./shell');
    return { ...mod, exec, execFile };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('shell helpers', () => {
    it('supports the legacy trusted runCommand path', async () => {
        const mod = await loadShellModule();

        expect(await mod.runCommand('whoami')).toBe('whoami');
        expect(await mod.runCommand('hostname')).toBe('hostname');
        expect(await mod.runCommand('ping 127.0.0.1')).toBe('partial ping output');
        await expect(mod.runCommand('sleep 10', 100)).rejects.toThrow();
        await expect(mod.runCommand('rm -rf /')).rejects.toThrow(/not allowed/i);
        await expect(mod.runCommand('whoami; rm -rf /')).rejects.toThrow(/not allowed/i);
    });

    it('runs structured programs and allows configured exit codes', async () => {
        const mod = await loadShellModule();

        expect(await mod.runProgram('docker', ['restart', 'pipi-bot'])).toBe('restarted');
        expect(await mod.capturePackets('icmp', 1, 5)).toContain('capture complete');
    });

    it('exposes typed wrappers for diagnostics commands', async () => {
        const mod = await loadShellModule();

        expect(await mod.pingHost('example.com', 1)).toContain('ping');
        expect(await mod.dnsLookup('example.com')).toContain('93.184.216.34');
        expect(await mod.traceRoute('example.com')).toContain('traceroute');
        expect(await mod.nmapPortScan('192.168.1.10', '80,443')).toContain('nmap');
        expect(await mod.listArpTable()).toContain('192.168.1.2');
        expect(await mod.listNetworkConnections('established')).toContain('netstat');
        expect(await mod.listNetworkConnections('all')).toContain('netstat');
        expect(await mod.listNetworkConnections('listening')).toContain('ss');
        expect(await mod.dockerPs('{{.Names}}')).toContain('docker');
        expect(await mod.dockerRestart('pipi-bot')).toBe('restarted');
        expect(await mod.dockerLogs('pipi-bot', 10)).toContain('docker');
        await expect(mod.journalctlErrors(5)).rejects.toThrow(/permission denied/i);
        expect(await mod.wifiSignal()).toBe('WiFi: N/A');
        expect(await mod.listUsbDevices()).toContain('lsusb');
        expect(await mod.hcitoolName('aa:bb:cc:dd:ee:ff')).toContain('hcitool');
    });

    it('rejects invalid structured arguments', async () => {
        const mod = await loadShellModule();

        await expect(mod.nmapPortScan('not-an-ip')).rejects.toThrow(/IPv4/i);
        await expect(mod.dnsLookup('.bad-host')).rejects.toThrow(/hostname/i);
        await expect(mod.dockerRestart('bad name!')).rejects.toThrow(/сервиса/i);
        await expect(mod.hcitoolName('bad-mac')).rejects.toThrow(/MAC/i);
        await expect(mod.capturePackets('icmp; rm -rf /', 1, 1)).rejects.toThrow(/запрещ/);
    });

    it('reports HTTP probe status and duration', async () => {
        const mod = await loadShellModule();
        global.fetch = vi.fn(async () => ({ status: 204 })) as any;

        const result = await mod.httpStatusProbe('https://example.com/health');

        expect(result).toMatch(/^204 \d+\.\d{2}s$/);
    });
});
