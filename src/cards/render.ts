// src/cards/render.ts
// Card to PNG: draw the card's page (src/cards/designs.ts) in headless Chrome
// and screenshot the card. One Chrome stays open between cards and comes back
// by itself if it dies.
//
// The page is fully locked down: JavaScript off, and every network request
// refused, so text that came from the model or a web page can only ever be
// text on a picture.

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'puppeteer-core';
import type { Card } from './cards.ts';
import { cardDocument, cardWidth } from './designs.ts';
import type { CardTheme } from './designs.ts';

export interface CardRendererConfig {
    // Where the PNG files are written (MEDIA_DIR).
    outDir: string;
    theme: CardTheme;
    timeZone: string;
    // CHROME_PATH. Default: the installed Google Chrome.
    executablePath?: string;
    now?: () => Date;
}

export interface CardRenderer {
    // The absolute path of a PNG. Throws on any failure.
    render(card: Card): Promise<string>;
    close(): Promise<void>;
}

// Files stay a day so the bridge has long finished with them, then go.
const KEEP_MS = 24 * 3600 * 1000;
// 2x keeps the picture sharp on a phone at a sensible file size.
const SCALE = 2;

async function pruneOld(dir: string, now: number): Promise<void> {
    for (const name of await readdir(dir)) {
        if (!name.startsWith('card-')) continue;
        const path = join(dir, name);
        if (now - (await stat(path)).mtimeMs > KEEP_MS) await rm(path, { force: true });
    }
}

export function createCardRenderer(config: CardRendererConfig): CardRenderer {
    const outDir = resolve(config.outDir);
    const now = config.now ?? (() => new Date());
    let browser: Browser | null = null;
    let launching: Promise<Browser> | null = null;

    async function getBrowser(): Promise<Browser> {
        if (browser?.connected) return browser;
        launching ??= (async () => {
            const puppeteer = (await import('puppeteer-core')).default;
            const b = await puppeteer.launch({
                ...(config.executablePath ? { executablePath: config.executablePath } : { channel: 'chrome' as const }),
                headless: true,
                args: ['--disable-component-update', '--no-first-run', '--no-default-browser-check'],
            });
            b.on('disconnected', () => { if (browser === b) browser = null; });
            browser = b;
            return b;
        })().finally(() => { launching = null; });
        return launching;
    }

    async function attempt(card: Card, path: string): Promise<void> {
        const page = await (await getBrowser()).newPage();
        try {
            await page.setJavaScriptEnabled(false);
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                if (request.url().startsWith('data:') || request.url() === 'about:blank') void request.continue();
                else void request.abort('blockedbyclient');
            });
            await page.setViewport({ width: cardWidth(card), height: 900, deviceScaleFactor: SCALE });
            await page.setContent(cardDocument(card, { theme: config.theme, timeZone: config.timeZone, now: now() }), { waitUntil: 'load', timeout: 15_000 });
            const element = await page.$('#card');
            if (!element) throw new Error('card element missing');
            await element.screenshot({ path: path as `${string}.png`, type: 'png' });
        } finally {
            await page.close().catch(() => undefined);
        }
    }

    return {
        async render(card) {
            await mkdir(outDir, { recursive: true });
            await pruneOld(outDir, Date.now()).catch(() => {});
            const path = join(outDir, `card-${randomUUID()}.png`);
            try {
                await attempt(card, path);
            } catch {
                // One retry: the usual cause is a Chrome that died between cards.
                await attempt(card, path);
            }
            return path;
        },
        async close() {
            await browser?.close().catch(() => undefined);
            browser = null;
        },
    };
}
