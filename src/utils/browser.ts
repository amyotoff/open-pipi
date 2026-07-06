import dns from 'dns/promises';
import { LookupAddress } from 'dns';
import net from 'net';

type LookupFn = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;
type RouteLike = {
    request: () => { url: () => string };
    abort: () => Promise<void>;
    continue: () => Promise<void>;
};
type BrowserContextLike = {
    newPage: () => Promise<any>;
    route: (url: string, handler: (route: RouteLike) => Promise<void>) => Promise<void> | void;
    close: () => Promise<void>;
};

let playwrightLoader: Promise<{ chromium: { connectOverCDP: (url: string) => Promise<any> } }> | null = null;

async function loadPlaywrightCore(): Promise<{ chromium: { connectOverCDP: (url: string) => Promise<any> } }> {
    if (!playwrightLoader) {
        playwrightLoader = import('playwright-core').catch((error: any) => {
            playwrightLoader = null;

            if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
                throw new Error(
                    'Browser automation requires the optional package "playwright-core". Run "pnpm install" without "--no-optional", or add "playwright-core" explicitly.'
                );
            }

            throw error;
        });
    }

    return playwrightLoader;
}

function isBlockedHostname(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local');
}

function isPrivateOrLocalAddress(address: string): boolean {
    const version = net.isIP(address);

    if (version === 4) {
        const [a, b] = address.split('.').map(Number);
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        );
    }

    if (version === 6) {
        const normalized = address.toLowerCase();
        return (
            normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe8') ||
            normalized.startsWith('fe9') ||
            normalized.startsWith('fea') ||
            normalized.startsWith('feb')
        );
    }

    return true;
}

export async function assertSafeBrowserUrl(url: string, lookup: LookupFn = dns.lookup): Promise<string> {
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Разрешены только http/https URL.');
    }

    if (!parsed.hostname) {
        throw new Error('URL не содержит hostname.');
    }

    if (isBlockedHostname(parsed.hostname)) {
        throw new Error(`Доступ к локальному hostname запрещён: ${parsed.hostname}`);
    }

    if (net.isIP(parsed.hostname)) {
        throw new Error('Доступ по raw IP запрещён. Используй публичный домен.');
    }

    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
        throw new Error(`Не удалось разрешить hostname: ${parsed.hostname}`);
    }

    for (const entry of addresses) {
        if (isPrivateOrLocalAddress(entry.address)) {
            throw new Error(`Доступ к приватному адресу запрещён: ${entry.address}`);
        }
    }

    return parsed.toString();
}

export async function withBrowserContext<T>(action: (context: BrowserContextLike) => Promise<T>): Promise<T> {
    const cdpUrl = process.env.CHROMIUM_CDP_URL || 'http://127.0.0.1:9222';
    const { chromium } = await loadPlaywrightCore();

    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = await browser.newContext();

    await context.route('**/*', async (route: RouteLike) => {
        const requestUrl = route.request().url();

        try {
            const parsed = new URL(requestUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                await route.abort();
                return;
            }

            await assertSafeBrowserUrl(requestUrl);
            await route.continue();
        } catch {
            await route.abort();
        }
    });

    try {
        return await action(context);
    } finally {
        await context.close();
        await browser.close();
    }
}
