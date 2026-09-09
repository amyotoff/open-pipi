import { describe, expect, it, vi } from 'vitest';
import type { SetupService } from '../setup/service';
import { runSetupCli, type SetupCliDependencies } from './setup';

function harness(options: { opened?: boolean } = {}) {
    const output: string[] = [];
    const errors: string[] = [];
    const signals = new Map<string, () => void>();
    const service = {
        status: vi.fn(async () => ({ phase: 'telegram', provider: { configured: true }, secret: undefined })),
        dispose: vi.fn(async () => undefined),
    };
    const server = {
        url: 'http://127.0.0.1:43123/session/private-bootstrap-token',
        origin: 'http://127.0.0.1:43123',
        close: vi.fn(async () => undefined),
    };
    const dependencies: SetupCliDependencies = {
        platform: 'darwin',
        cwd: '/repo',
        env: {},
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
        createService: vi.fn(async () => service as unknown as SetupService),
        startServer: vi.fn(async () => server),
        openUrl: vi.fn(async () => options.opened ?? true),
        onceSignal: (signal, handler) => signals.set(signal, handler),
    };
    return { dependencies, output, errors, signals, service, server };
}

describe('setup CLI', () => {
    it('enables the private proposal review only with the experimental flag', async () => {
        const test = harness();
        expect(await runSetupCli(['--agent-onboarding'], test.dependencies)).toBe(0);
        expect(test.dependencies.startServer).toHaveBeenCalledWith(test.service, { agentOnboarding: true });
        expect(test.output.join('')).not.toContain('private-bootstrap-token');
    });

    it('rejects combining read-only JSON with the experimental interactive page', async () => {
        const test = harness();
        expect(await runSetupCli(['--json', '--agent-onboarding'], test.dependencies)).toBe(2);
        expect(test.dependencies.createService).not.toHaveBeenCalled();
    });

    it('returns a bounded read-only JSON status without starting a server', async () => {
        const test = harness();

        expect(await runSetupCli(['--json'], test.dependencies)).toBe(0);
        expect(test.dependencies.createService).toHaveBeenCalledWith({ readOnly: true });
        expect(test.dependencies.startServer).not.toHaveBeenCalled();
        expect(test.dependencies.openUrl).not.toHaveBeenCalled();
        expect(test.service.dispose).toHaveBeenCalledOnce();
        expect(JSON.parse(test.output.join(''))).toMatchObject({ phase: 'telegram' });
        expect(test.output.join('')).not.toContain('private-bootstrap-token');
    });

    it('opens the session URL without stdin or printing it and cleans up on signals', async () => {
        const test = harness();

        expect(await runSetupCli([], test.dependencies)).toBe(0);
        expect(test.dependencies.openUrl).toHaveBeenCalledWith(test.server.url, 'darwin');
        expect(test.output.join('')).toContain(test.server.origin);
        expect(test.output.join('')).not.toContain('private-bootstrap-token');
        expect(test.signals.has('SIGINT')).toBe(true);
        test.signals.get('SIGINT')?.();
        await vi.waitFor(() => expect(test.server.close).toHaveBeenCalledOnce());
        expect(test.service.dispose).toHaveBeenCalledOnce();
    });

    it('closes cleanly and gives a private-terminal fallback when browser opening fails', async () => {
        const test = harness({ opened: false });

        expect(await runSetupCli([], test.dependencies)).toBe(1);
        expect(test.server.close).toHaveBeenCalledOnce();
        expect(test.service.dispose).toHaveBeenCalledOnce();
        expect(test.errors.join('')).toContain('pnpm setup -- --show-link');
        expect(test.errors.join('')).not.toContain('private-bootstrap-token');
    });

    it('prints the session-bearing link only behind the explicit show-link flag', async () => {
        const test = harness();

        expect(await runSetupCli(['--show-link'], test.dependencies)).toBe(0);
        expect(test.dependencies.openUrl).not.toHaveBeenCalled();
        expect(test.output.join('')).toContain('Short-lived local setup link (keep private)');
        expect(test.output.join('')).toContain('private-bootstrap-token');
    });
});
