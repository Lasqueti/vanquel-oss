// worker/chrome-page.ts
// BrowserPage on real Google Chrome through puppeteer-core. Real, visible
// Chrome on a logged-in Mac desktop is blocked by far fewer sites than a
// headless or bundled browser; set WORKER_HEADLESS=1 to hide the window.
//
// Each customer gets their own Chrome profile directory (cookies, logins they
// typed themselves), mode 0700, under WORKER_PROFILES_DIR. Profiles are
// separate directories under one macOS user: that is isolation between
// customers' cookies, not a security sandbox. Do not run this as a user that
// can read anything sensitive.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import type { BrowserPage, PageSnapshot } from './loop.ts';
import { HOST_RESOLVER_RULES, urlAllowed } from './guard.ts';

const REF_ATTR = 'data-agent-ref';

export interface ChromeOptions {
    profilesDir: string;
    profile: string;
    headless: boolean;
    executablePath?: string;
}

export async function openChrome(options: ChromeOptions): Promise<{ page: BrowserPage; close: () => Promise<void> }> {
    const puppeteer = (await import('puppeteer-core')).default;
    const userDataDir = join(options.profilesDir, options.profile.replace(/[^a-z0-9-]/gi, ''));
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const browser: Browser = await puppeteer.launch({
        ...(options.executablePath ? { executablePath: options.executablePath } : { channel: 'chrome' }),
        headless: options.headless,
        userDataDir,
        defaultViewport: { width: 1280, height: 900 },
        args: [HOST_RESOLVER_RULES, '--disable-component-update', '--no-first-run', '--no-default-browser-check'],
    });
    const page: Page = (await browser.pages())[0] ?? (await browser.newPage());

    // Block every request (pages, frames, scripts, redirects) to a non-public address.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:') || urlAllowed(url)) void request.continue();
        else void request.abort('blockedbyclient');
    });

    const settle = () => page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => undefined);
    const byRef = (ref: number) => `[${REF_ATTR}="${ref}"]`;

    const browserPage: BrowserPage = {
        async goto(url) {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await settle();
        },
        async snapshot(): Promise<PageSnapshot> {
            const result = await page.evaluate((attr: string) => {
                const selector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [onclick]';
                const elements: Array<{ ref: number; role: string; label: string; sensitive: boolean }> = [];
                let ref = 0;
                for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
                    const box = node.getBoundingClientRect();
                    if (box.width === 0 || box.height === 0 || getComputedStyle(node).visibility === 'hidden') continue;
                    ref += 1;
                    node.setAttribute(attr, String(ref));
                    const input = node as HTMLInputElement;
                    const label = (node.getAttribute('aria-label') || node.innerText || input.placeholder || input.name || input.value || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
                    const hints = `${input.type || ''} ${node.getAttribute('autocomplete') || ''} ${input.name || ''} ${node.id || ''}`.toLowerCase();
                    const sensitive = input.type === 'password' || /cc-|one-time-code|card|cvv|cvc|password|passcode|otp|ssn|security.?code/.test(hints);
                    const role = node.getAttribute('role') || node.tagName.toLowerCase() + (input.type ? `:${input.type}` : '');
                    elements.push({ ref, role, label, sensitive });
                }
                return { url: location.href, title: document.title, text: document.body?.innerText ?? '', elements };
            }, REF_ATTR);
            return result;
        },
        async click(ref) {
            await page.click(byRef(ref));
            await settle();
        },
        async type(ref, text, submit) {
            await page.click(byRef(ref), { count: 3 });
            await page.type(byRef(ref), text, { delay: 20 });
            if (submit) await page.keyboard.press('Enter');
            await settle();
        },
        async press(key) {
            await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]);
            await settle();
        },
        async scroll(direction) {
            await page.evaluate((dy: number) => window.scrollBy(0, dy), direction === 'up' ? -700 : 700);
        },
        async back() {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
            await settle();
        },
    };
    return { page: browserPage, close: () => browser.close() };
}
