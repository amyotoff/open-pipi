import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const HTTP_PROBE_TIMEOUT_MS = 5000;
const ALLOWED_HOST_OR_IP_PATTERN = /^[a-zA-Z0-9.-]+$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const PORT_SPEC_PATTERN = /^[0-9,-]+$/;
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MAC_ADDRESS_PATTERN = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const TCPDUMP_FILTER_PATTERN = /^[a-zA-Z0-9.:/_ -]+$/;

/**
 * Legacy shell runner kept only for trusted internal probes that still use
 * fixed command strings. LLM-facing tools must use the structured execFile
 * helpers below instead of free-form shell strings.
 */
const ALLOWED_PREFIXES = [
    'ping',
    'nmap',
    'traceroute',
    'dig',
    'nslookup',
    'ip ',
    'ip\t',
    'arp',
    'ss ',
    'ss\t',
    'cat /proc',
    'cat /sys',
    'date',
    'uptime',
    'hostname',
    'whoami',
    'uname',
    'rfkill',
    'hciconfig',
    'bluetoothctl',
    'tcpdump',
    'netstat',
    'ifconfig',
    'iwconfig',
    'free',
    'df',
    'top -bn1',
    'ps ',
    'dmesg',
    'vcgencmd',
    'lsusb',
    'docker ps',
    'docker logs',
    'docker restart',
    'journalctl',
];

export function validateCommand(command: string): void {
    const cmd = command.trim();

    if (/[;`]|\$\(|\$\{|\|\||&&/.test(cmd)) {
        throw new Error('Command not allowed: shell operators detected');
    }

    const beforePipe = cmd.split('|')[0].trim();
    if (!ALLOWED_PREFIXES.some((prefix) => beforePipe.startsWith(prefix))) {
        throw new Error(`Command not allowed: ${cmd.split(' ')[0]}`);
    }
}

export async function runCommand(command: string, timeoutMs: number = 10000): Promise<string> {
    validateCommand(command);

    try {
        const { stdout } = await execAsync(command, { timeout: timeoutMs });
        return stdout.trim();
    } catch (err: any) {
        if (err.stdout) return err.stdout.trim();
        throw new Error(`Command failed: ${err.message}`, { cause: err });
    }
}

export class ToolCommandError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolCommandError';
    }
}

type ProgramSpec = {
    file: string;
    args: string[];
    options?: RunProgramOptions;
};

type RunProgramOptions = {
    timeoutMs?: number;
    allowExitCodes?: number[];
    maxBuffer?: number;
};

const DNS_LOOKUP_COMMANDS = (hostname: string): ProgramSpec[] => [
    { file: 'nslookup', args: [hostname], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
    { file: 'dig', args: ['+short', hostname], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
];

const ARP_TABLE_COMMANDS: ProgramSpec[] = [
    { file: 'arp', args: ['-a'], options: { timeoutMs: 5000 } },
    { file: 'ip', args: ['neigh', 'show'], options: { timeoutMs: 5000 } },
];

const NETWORK_CONNECTION_COMMANDS: Record<'listening' | 'established' | 'all', ProgramSpec[]> = {
    established: [
        { file: 'ss', args: ['-tnp', 'state', 'established'], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
        { file: 'netstat', args: ['-tnp'], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
    ],
    all: [
        { file: 'ss', args: ['-tnap'], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
        { file: 'netstat', args: ['-tnap'], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
    ],
    listening: [
        { file: 'ss', args: ['-tlnp'], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
        { file: 'netstat', args: ['-tlnp'], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
    ],
};

function normalizeOutput(stdout: string | Buffer, stderr: string | Buffer): string {
    return [String(stdout || ''), String(stderr || '')]
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function trimValue(value: string): string {
    return value.trim();
}

function ensurePattern(
    value: string,
    pattern: RegExp,
    errorMessage: string,
    normalize: (value: string) => string = trimValue
): string {
    const normalized = normalize(value);
    if (!pattern.test(normalized)) {
        throw new ToolCommandError(errorMessage);
    }
    return normalized;
}

function ensureDelimitedHostname(host: string): string {
    if (host.startsWith('.') || host.endsWith('.')) {
        throw new ToolCommandError('Некорректный hostname.');
    }
    return host;
}

export async function runProgram(file: string, args: string[], options: RunProgramOptions = {}): Promise<string> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, allowExitCodes = [], maxBuffer = DEFAULT_MAX_BUFFER } = options;

    return await new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
            const output = normalizeOutput(stdout, stderr);

            if (!error) {
                resolve(output);
                return;
            }

            const exitCode = typeof (error as any).code === 'number' ? (error as any).code : null;
            if (exitCode !== null && allowExitCodes.includes(exitCode)) {
                resolve(output);
                return;
            }

            reject(new ToolCommandError(output || error.message));
        });
    });
}

async function runProgramFallback(commands: ProgramSpec[]): Promise<string> {
    let lastError: unknown;

    for (const command of commands) {
        try {
            return await runProgram(command.file, command.args, command.options);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError instanceof Error ? lastError : new ToolCommandError('Command failed');
}

function ensureHostOrIp(value: string): string {
    return ensurePattern(value, ALLOWED_HOST_OR_IP_PATTERN, 'Допустимы только hostname/IP без спецсимволов.');
}

function ensureIpv4(value: string): string {
    return ensurePattern(value, IPV4_PATTERN, 'Некорректный IPv4-адрес.');
}

function ensureHostname(value: string): string {
    return ensureDelimitedHostname(ensurePattern(value, ALLOWED_HOST_OR_IP_PATTERN, 'Некорректный hostname.'));
}

function ensurePortSpec(value: string): string {
    return ensurePattern(value, PORT_SPEC_PATTERN, 'Некорректный список портов.');
}

function ensureContainerName(value: string): string {
    return ensurePattern(value, CONTAINER_NAME_PATTERN, 'Некорректное имя сервиса/контейнера.');
}

function ensureMacAddress(value: string): string {
    return ensurePattern(value, MAC_ADDRESS_PATTERN, 'Некорректный MAC-адрес.', (input) => input.trim().toLowerCase());
}

function tokenizeTcpdumpFilter(filter: string): string[] {
    const trimmed = trimValue(filter);
    if (!trimmed) return [];
    ensurePattern(trimmed, TCPDUMP_FILTER_PATTERN, 'Фильтр tcpdump содержит запрещённые символы.', (value) => value);
    return trimmed.split(/\s+/).filter(Boolean);
}

export async function pingHost(target: string, count = 4): Promise<string> {
    return await runProgram('ping', ['-c', String(count), '-W', '3', ensureHostOrIp(target)], {
        timeoutMs: count * 4000 + 2000,
    });
}

export async function dnsLookup(hostname: string): Promise<string> {
    return await runProgramFallback(DNS_LOOKUP_COMMANDS(ensureHostname(hostname)));
}

export async function traceRoute(target: string): Promise<string> {
    return await runProgram('traceroute', ['-m', '15', '-w', '2', ensureHostOrIp(target)], {
        timeoutMs: 30000,
    });
}

export async function nmapPortScan(target: string, ports?: string): Promise<string> {
    const args = ['-Pn'];
    if (ports) {
        args.push('-p', ensurePortSpec(ports));
    } else {
        args.push('--top-ports', '100');
    }
    args.push(ensureIpv4(target));
    return await runProgram('nmap', args, { timeoutMs: 30000 });
}

export async function listArpTable(): Promise<string> {
    return await runProgramFallback(ARP_TABLE_COMMANDS);
}

export async function capturePackets(filter: string, seconds: number, count: number): Promise<string> {
    return await runProgram(
        'timeout',
        [String(seconds), 'tcpdump', '-nn', '-c', String(count), ...tokenizeTcpdumpFilter(filter)],
        { timeoutMs: (seconds + 2) * 1000, allowExitCodes: [124] }
    );
}

export async function listNetworkConnections(filter: 'listening' | 'established' | 'all'): Promise<string> {
    return await runProgramFallback(NETWORK_CONNECTION_COMMANDS[filter]);
}

export async function dockerPs(format?: string): Promise<string> {
    const args = ['ps'];
    if (format) args.push('--format', format);
    return await runProgram('docker', args, { timeoutMs: 5000 });
}

export async function dockerRestart(container: string): Promise<string> {
    return await runProgram('docker', ['restart', ensureContainerName(container)], { timeoutMs: 30000 });
}

export async function dockerLogs(container: string, lines: number): Promise<string> {
    return await runProgram('docker', ['logs', '--tail', String(lines), ensureContainerName(container)], {
        timeoutMs: 10000,
    });
}

export async function journalctlErrors(lines: number): Promise<string> {
    return await runProgram('journalctl', ['-p', 'err..alert', '-n', String(lines), '--no-pager'], {
        timeoutMs: 10000,
    });
}

export async function httpStatusProbe(url: string): Promise<string> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), HTTP_PROBE_TIMEOUT_MS);

    try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal });
        const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
        return `${response.status} ${duration}s`;
    } finally {
        clearTimeout(timer);
    }
}

export async function wifiSignal(): Promise<string> {
    const output = await runProgram('iwconfig', [], { timeoutMs: 3000 });
    const line = output.split('\n').find((entry) => /signal level/i.test(entry));
    return line?.trim() || 'WiFi: N/A';
}

export async function listUsbDevices(): Promise<string> {
    return await runProgram('lsusb', [], { timeoutMs: 5000 });
}

export async function hcitoolName(macAddress: string): Promise<string> {
    return await runProgram('hcitool', ['name', ensureMacAddress(macAddress)], { timeoutMs: 5000 });
}
