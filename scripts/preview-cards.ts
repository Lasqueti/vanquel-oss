// scripts/preview-cards.ts
// Draws every card with made-up sample data, in both themes, so you can see
// them without a customer: npm run cards:preview
// The PNGs land in data/card-previews/. Needs Google Chrome (or CHROME_PATH).

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile, env } from '../src/config.ts';
import type { Card } from '../src/cards/cards.ts';
import { createCardRenderer } from '../src/cards/render.ts';
import type { CardTheme } from '../src/cards/designs.ts';

loadEnvFile();
const outDir = 'data/card-previews';
// The cards are drawn as if it were 3 PM UTC today, so sample times read like
// a real afternoon of bookings.
const today = new Date();
const sampleNow = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 15);
const at = (hours: number) => new Date(sampleNow + hours * 3_600_000).toISOString();

const samples: Card[] = [
    { type: 'booking', rows: [
        { at: at(2), title: 'Haircut', meta: '45 min' },
        { at: at(25.5), title: 'Beard trim', meta: '20 min' },
        { at: at(74), title: 'Haircut and colour', meta: '90 min' },
    ] },
    { type: 'reminders', rows: [
        { at: at(1), title: 'Bring your parking pass' },
        { at: at(23.5), title: 'Pick up the dry cleaning' },
        { at: at(50), title: 'Call back about the quote' },
    ] },
    { type: 'confirm', title: 'Book this?', ask: 'Reply YES and it is yours', details: [
        { label: 'What', value: 'Haircut with Sam' },
        { label: 'When', value: 'Thursday at 3:00 PM' },
        { label: 'How long', value: '45 minutes' },
        { label: 'Price', value: '$40, paid in the shop' },
    ] },
    { type: 'result', title: 'Three hardware stores open late near you', subtitle: 'Checked their websites just now', items: [
        { name: 'Corner Hardware', detail: 'Open until 9 PM, 0.4 mi' },
        { name: 'Main Street Tools and Supply', detail: 'Open until 10 PM, 1.2 mi' },
        { name: 'Lakeside Home Center', detail: 'Open until 11 PM, 2.8 mi' },
    ] },
];

await mkdir(outDir, { recursive: true });
for (const theme of ['light', 'dark'] as CardTheme[]) {
    const renderer = createCardRenderer({ outDir, theme, timeZone: env('TIMEZONE', 'UTC'), now: () => new Date(sampleNow), executablePath: env('CHROME_PATH') || undefined });
    try {
        for (const card of samples) {
            const path = await renderer.render(card);
            const named = join(outDir, `${card.type}-${theme}.png`);
            await copyFile(path, named);
            console.log(named);
        }
    } finally {
        await renderer.close();
    }
}
