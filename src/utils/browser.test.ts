import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadBrowserModule() {
    vi.resetModules();
    const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    let routeHandler: any;
    const route = vi.fn(async (_pattern: string, handler: any) => {
        routeHandler = handler;
    });
    const context = {
        route,
        close: vi.fn(),
    };
    const browser = {
        newContext: vi.fn(async () => context),
        close: vi.fn(),
    };
    const chromium = {
        connectOverCDP: vi.fn(async () => browser),
    };

    vi.doMock('dns/promises', () => ({
        default: { lookup: dnsLookup },
        lookup: dnsLookup,
    }));
    vi.doMock('playwright-core', () => ({ chromium }));
    const mod = await import('./browser');
    return {
        ...mod,
        chromium,
        browser,
        context,
        route,
        dnsLookup,
        invokeRoute: async (requestUrl: string) => {
            const abort = vi.fn(async () => undefined);
            const cont = vi.fn(async () => undefined);
            await routeHandler({
                request: () => ({ url: () => requestUrl }),
                abort,
                continue: cont,
            });
            return { abort, continue: cont };
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('browser URL guard', () => {
    it('should allow a public https URL', async () => {
        const { assertSafeBrowserUrl } = await loadBrowserModule();
        const safeUrl = await assertSafeBrowserUrl('https://example.com/path', async () => [
            { address: '93.184.216.34', family: 4 },
        ]);

        expect(safeUrl).toBe('https://example.com/path');
    });

    it('should reject localhost hostnames', async () => {
        const { assertSafeBrowserUrl } = await loadBrowserModule();
        await expect(
            assertSafeBrowserUrl('http://localhost:8080', async () => [{ address: '127.0.0.1', family: 4 }])
        ).rejects.toThrow(/локальному hostname/i);
    });

    it('should reject raw IP targets', async () => {
        const { assertSafeBrowserUrl } = await loadBrowserModule();
        await expect(
            assertSafeBrowserUrl('http://8.8.8.8', async () => [{ address: '8.8.8.8', family: 4 }])
        ).rejects.toThrow(/raw IP/i);
    });

    it('should reject hostnames resolving to private addresses', async () => {
        const { assertSafeBrowserUrl } = await loadBrowserModule();
        await expect(
            assertSafeBrowserUrl('https://example.test', async () => [{ address: '192.168.1.20', family: 4 }])
        ).rejects.toThrow(/приватному адресу/i);
    });

    it('should reject unsupported protocols, empty DNS and IPv6 local targets', async () => {
        const { assertSafeBrowserUrl } = await loadBrowserModule();

        await expect(
            assertSafeBrowserUrl('ftp://example.com/file', async () => [{ address: '93.184.216.34', family: 4 }])
        ).rejects.toThrow(/http\/https/i);
        await expect(assertSafeBrowserUrl('https://missing.example', async () => [])).rejects.toThrow(
            /Не удалось разрешить hostname/i
        );
        await expect(
            assertSafeBrowserUrl('https://ipv6.example', async () => [{ address: '::1', family: 6 }])
        ).rejects.toThrow(/приватному адресу/i);
    });

    it('should create and close an isolated browser context', async () => {
        const { withBrowserContext, context, browser, route } = await loadBrowserModule();

        const result = await withBrowserContext(async () => 'ok');

        expect(result).toBe('ok');
        expect(route).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalled();
        expect(browser.close).toHaveBeenCalled();
    });

    it('should abort blocked requests inside the browser context', async () => {
        const { withBrowserContext, invokeRoute } = await loadBrowserModule();

        await withBrowserContext(async () => {
            const fileRoute = await invokeRoute('file:///etc/passwd');
            expect(fileRoute.abort).toHaveBeenCalled();
            expect(fileRoute.continue).not.toHaveBeenCalled();

            const privateRoute = await invokeRoute('https://printer.local/status');
            expect(privateRoute.abort).toHaveBeenCalled();
            expect(privateRoute.continue).not.toHaveBeenCalled();

            const publicRoute = await invokeRoute('https://example.com/article');
            expect(publicRoute.continue).toHaveBeenCalled();
            expect(publicRoute.abort).not.toHaveBeenCalled();

            return 'ok';
        });
    });
});
