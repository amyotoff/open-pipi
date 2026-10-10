import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentOnboardingService } from '../agent-onboarding/service';
import { createOnboardingMcpServer } from '../agent-onboarding/mcp';
import { handleAgentOnboardingRequest } from '../agent-onboarding/public';

type OnboardingCommand = { mode: 'serve'; port: number; publicOrigin?: string } | { mode: 'mcp'; dataDir: string };

const USAGE =
    'Usage: agent-onboarding serve [--port 8787] [--public-origin https://your-domain]\n' +
    '       agent-onboarding mcp --data-dir /absolute/path/to/installation-data\n';

export function parseOnboardingArguments(argv: readonly string[], cwd: string): OnboardingCommand {
    const args = argv.filter((argument) => argument !== '--');
    const mode = args.shift();
    if (mode !== 'serve' && mode !== 'mcp') throw new Error('Invalid command.');
    const values = new Map<string, string>();
    while (args.length) {
        const key = args.shift()!;
        const value = args.shift();
        const allowed = mode === 'serve' ? ['--port', '--public-origin'] : ['--data-dir'];
        if (!allowed.includes(key) || !value || value.startsWith('--') || values.has(key)) {
            throw new Error('Invalid option.');
        }
        values.set(key, value);
    }
    if (mode === 'mcp') {
        const dataDir = values.get('--data-dir');
        if (!dataDir || dataDir.includes('\0')) throw new Error('Explicit data directory required.');
        return { mode, dataDir: path.resolve(cwd, dataDir) };
    }
    const portText = values.get('--port') || '8787';
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error('Invalid port.');
    }
    const configuredOrigin = values.get('--public-origin');
    if (configuredOrigin) {
        const url = new URL(configuredOrigin);
        const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        if (
            (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
        ) {
            throw new Error('Invalid public origin.');
        }
        return { mode, port, publicOrigin: url.origin };
    }
    return { mode, port };
}

export async function startOnboardingDocsServer(options: { port: number; publicOrigin?: string }) {
    let localOrigin = '';
    const server = createServer((request, response) => {
        void (async () => {
            if (
                !(await handleAgentOnboardingRequest(request, response, {
                    publicOrigin: options.publicOrigin || localOrigin,
                }))
            ) {
                response.statusCode = 404;
                response.setHeader('content-type', 'text/plain; charset=utf-8');
                response.end('Not found.');
            }
        })().catch(() => {
            if (!response.headersSent) {
                response.statusCode = 500;
                response.setHeader('content-type', 'text/plain; charset=utf-8');
            }
            response.end('The onboarding documentation is unavailable.');
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        url: `${localOrigin}/agent-onboarding`,
        close: () =>
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}

export async function runAgentOnboardingCli(argv: readonly string[]): Promise<number> {
    let command: OnboardingCommand;
    try {
        command = parseOnboardingArguments(argv, process.cwd());
    } catch {
        process.stderr.write(USAGE);
        return 2;
    }
    try {
        const running =
            command.mode === 'serve'
                ? await startOnboardingDocsServer(command)
                : await (async () => {
                      const server = createOnboardingMcpServer(
                          createAgentOnboardingService({ dataDir: command.dataDir })
                      );
                      await server.connect(new StdioServerTransport());
                      return server;
                  })();
        if ('url' in running) process.stdout.write(`Open PiPi experimental instructions: ${running.url}\n`);
        let closing = false;
        const close = (): void => {
            if (closing) return;
            closing = true;
            void running.close().catch(() => {
                process.exitCode = 1;
            });
        };
        process.once('SIGINT', close);
        process.once('SIGTERM', close);
        return 0;
    } catch {
        process.stderr.write('Open PiPi agent onboarding could not start. Check the command and local files.\n');
        return 1;
    }
}

if (require.main === module) {
    void runAgentOnboardingCli(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
