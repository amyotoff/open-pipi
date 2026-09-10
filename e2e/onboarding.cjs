// A real, isolated browser against a test-lifetime loopback server or the public test site.
// Never reads a user browser profile, starts PiPi, or connects to Telegram/providers.
const assert = require('node:assert/strict');
const { existsSync, mkdirSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright-core');
const { handleAgentOnboardingRequest } = require('../src/agent-onboarding/public');

test('onboarding browser journey', { timeout: 120_000 }, async (t) => {
    let server;
    let browser;
    let base = process.env.ONBOARDING_E2E_BASE_URL;
    const artifacts = path.resolve('output/playwright');
    mkdirSync(artifacts, { recursive: true });
    try {
        if (!base) {
            server = createServer((request, response) => {
                if (!handleAgentOnboardingRequest(request, response, { sourceCommit: 'a'.repeat(40) })) {
                    response.writeHead(404).end();
                }
            });
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            base = `http://127.0.0.1:${server.address().port}`;
        }
        const origin = new URL(base).origin;
        const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        const executablePath =
            process.env.ONBOARDING_E2E_BROWSER ||
            (process.platform === 'darwin' && existsSync(macChrome) ? macChrome : undefined);
        browser = await chromium.launch({ headless: true, executablePath, timeout: 20_000 });
        const errors = [];
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico'))
                errors.push(message.text());
        });
        await page.goto(base, { waitUntil: 'networkidle' });

        await t.test('clear experiment and repository before copying', async () => {
            assert.match(await page.title(), /MVP|test|experiment/i);
            assert.match(await page.locator('.hero').innerText(), /automatic|automated/i);
            assert.doesNotMatch(await page.locator('#title').innerText(), /PiPi/);
            assert.match(await page.locator('body').innerText(), /Claude Code/);
            assert.match(await page.locator('body').innerText(), /ChatGPT/);
            const repository = page
                .locator('a[href="https://github.com/amyotoff/open-pipi"]')
                .filter({ hasText: 'https://github.com/amyotoff/open-pipi' });
            assert.equal(await repository.count(), 1);
            assert.equal(await repository.isVisible(), true);
            assert.equal(await page.locator('label[for="client"]').isVisible(), true);
            assert.equal(await page.locator('label[for="scenario"]').isVisible(), true);
        });

        const clients = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
        const scenarios = {
            macos: /macOS/,
            linux: /Linux/,
            windows: /WSL2/,
            rpi: /Raspberry Pi/,
            vps: /VPS/,
            update: /updat|обнов/i,
        };
        const prompts = new Set();
        for (const language of ['en', 'ru']) {
            if ((await page.locator('html').getAttribute('lang')) !== language) await page.locator('#language').click();
            for (const [client, clientName] of Object.entries(clients)) {
                for (const [scenario, target] of Object.entries(scenarios)) {
                    await t.test(`${language}: ${client} / ${scenario}`, async () => {
                        await page.locator('#client').selectOption(client);
                        await page.locator('#scenario').selectOption(scenario);
                        const prompt = await page.locator('#prompt').inputValue();
                        assert.ok(prompt.includes(clientName));
                        assert.match(prompt, target);
                        assert.ok(prompt.includes('https://github.com/amyotoff/open-pipi'));
                        assert.ok(prompt.includes(`${origin}/agent-onboarding/SKILL.md`));
                        assert.ok(prompt.includes(`${origin}/agent-onboarding/SKILL.txt`));
                        assert.match(prompt, /ChatGPT|web.?chat/i);
                        assert.match(prompt, /cloud|облачн/i);
                        assert.match(prompt, /target|целев/i);
                        assert.match(prompt, /secret|секрет/i);
                        assert.match(prompt, /background|фонов/i);
                        assert.match(
                            prompt,
                            language === 'en' ? /Install, configure, and start/ : /Установи, настрой и запусти/
                        );
                        assert.match(
                            prompt,
                            language === 'en'
                                ? /first verified Telegram reply/
                                : /первого подтверждённого ответа в Telegram/
                        );
                        assert.match(
                            prompt,
                            scenario === 'update'
                                ? language === 'en'
                                    ? /safe update/
                                    : /безопасное обновление/
                                : language === 'en'
                                  ? /fresh installation/
                                  : /новая установка/
                        );
                        assert.equal(
                            prompts.has(prompt),
                            false,
                            'Every client/scenario/language must give its own instruction'
                        );
                        prompts.add(prompt);
                        if (scenario === 'windows')
                            assert.match(await page.locator('#scenario-note').innerText(), /WSL2/);
                        if (scenario === 'vps') assert.match(prompt, /SSH/);
                        if (scenario === 'update') assert.match(prompt, /preserv|сохран/i);
                    });
                }
            }
        }
        assert.equal(prompts.size, 36);

        await t.test('clipboard success copies the exact selected prompt', async () => {
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
            await page.locator('#copy').click();
            await page.waitForFunction(() =>
                /Copied|Скопировано/.test(document.getElementById('copy-status').textContent)
            );
            assert.equal(
                await page.evaluate(() => navigator.clipboard.readText()),
                await page.locator('#prompt').inputValue()
            );
            await page.locator('#scenario').selectOption('windows');
            assert.equal(await page.locator('#copy-status').innerText(), '');
        });

        await t.test('clipboard rejection offers a selected manual fallback', async () => {
            // Only fault-inject the denied API; real click/event handler/selection still execute.
            await page.evaluate(() => {
                Object.defineProperty(navigator.clipboard, 'writeText', {
                    configurable: true,
                    value: async () => {
                        throw new Error('Denied');
                    },
                });
            });
            await page.locator('#copy').click();
            await page.waitForFunction(() =>
                /manually|вручную/.test(document.getElementById('copy-status').textContent)
            );
            const selected = await page.locator('#prompt').evaluate((element) => ({
                start: element.selectionStart,
                end: element.selectionEnd,
                length: element.value.length,
                focused: document.activeElement === element,
            }));
            assert.deepEqual(selected, { start: 0, end: selected.length, length: selected.length, focused: true });
        });

        await t.test('desktop and mobile layout and controls', async () => {
            await page.reload({ waitUntil: 'networkidle' });
            await page.screenshot({ path: path.join(artifacts, 'onboarding-desktop.png'), fullPage: true });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator('#client').selectOption('antigravity');
            await page.locator('#scenario').selectOption('vps');
            assert.match(await page.locator('#prompt').inputValue(), /Antigravity/);
            const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
            assert.equal(fits, true, 'Mobile page must not overflow horizontally');
            await page.screenshot({ path: path.join(artifacts, 'onboarding-mobile.png'), fullPage: true });
            await page.locator('#language').click();
            for (const width of [390, 320]) {
                await page.setViewportSize({ width, height: 844 });
                assert.equal(
                    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                    true,
                    `Russian mobile page must fit ${width}px`
                );
            }
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({ path: path.join(artifacts, 'onboarding-mobile-ru.png'), fullPage: true });
        });

        await t.test('Russian locale and language changes retain scenario and client', async () => {
            const russian = await browser.newContext({ locale: 'ru-RU' });
            try {
                const local = await russian.newPage();
                await local.goto(base);
                assert.equal(await local.locator('html').getAttribute('lang'), 'ru');
                await local.locator('#client').selectOption('codex');
                await local.locator('#scenario').selectOption('update');
                await local.locator('#language').click();
                assert.equal(await local.locator('#client').inputValue(), 'codex');
                assert.equal(await local.locator('#scenario').inputValue(), 'update');
                assert.match(await local.locator('#prompt').inputValue(), /updat/i);
            } finally {
                await russian.close();
            }
        });

        await t.test('without JavaScript the local-agent handoff is still clear', async () => {
            const noScript = await browser.newContext({ javaScriptEnabled: false });
            try {
                const fallback = await noScript.newPage();
                await fallback.goto(base);
                const note = await fallback.locator('noscript').innerText();
                assert.match(note, /Claude Code/);
                assert.match(note, /Codex/);
                assert.match(note, /Antigravity/);
                assert.match(note, /https:\/\/github.com\/amyotoff\/open-pipi/);
                assert.match(note, /ChatGPT/);
            } finally {
                await noScript.close();
            }
        });

        await t.test('linked instructions are readable and private routes absent', async () => {
            const request = context.request;
            const markdown = await request.get(`${origin}/agent-onboarding/SKILL.md`);
            const plain = await request.get(`${origin}/agent-onboarding/SKILL.txt`);
            assert.equal(markdown.status(), 200);
            assert.equal(plain.status(), 200);
            assert.match(plain.headers()['content-type'], /text\/plain/);
            assert.equal(await plain.text(), await markdown.text());
            assert.match(await plain.text(), /target/);
            const release = await request.get(`${origin}/agent-onboarding/release.json`);
            assert.equal(release.status(), 200);
            const manifest = await release.json();
            assert.equal(manifest.repository, 'https://github.com/amyotoff/open-pipi.git');
            assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
            for (const name of ['install', 'connect', 'workflow', 'troubleshooting']) {
                assert.equal((await request.get(`${origin}/agent-onboarding/references/${name}.md`)).status(), 200);
            }
            for (const privatePath of ['/api/status', '/mcp', '/.env', '/setup']) {
                assert.equal((await request.get(`${origin}${privatePath}`)).status(), 404);
            }
        });
        assert.deepEqual(errors, [], 'Browser must have no runtime or CSP errors');
    } finally {
        await browser?.close();
        if (server)
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            });
    }
});
