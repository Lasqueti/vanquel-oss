// src/cards/cards.ts
// Picture cards: what a card says, before it is drawn.
//
// Four cards, from the production card designs:
//   booking    this person's booked appointments, read from the store
//   reminders  this person's upcoming reminders, read from the store
//   confirm    "about to do this for you, reply YES", written by the model
//   result     what a web task found, written by the browser worker
//
// Cards that show a person's own data are built from the store, never from
// model text, so a card cannot show a booking that does not exist. Cards the
// model or the worker write are trimmed and capped here, so a runaway reply
// cannot draw a giant picture.
//
// A card is sent as a picture (src/cards/render.ts). That is what every
// customer can see. A tappable native iMessage card only shows for people who
// have your own iPhone app installed; see docs/CHANNELS.md.

import type { Address } from '../channels/types.ts';
import type { Store } from '../store.ts';

export const CARD_TYPES = ['booking', 'reminders', 'confirm', 'result'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export interface AgendaRow {
    // ISO 8601.
    at: string;
    title: string;
    // A short note on the right, e.g. "45 min".
    meta?: string;
}

export interface Detail {
    label: string;
    value: string;
}

export interface ResultItem {
    name: string;
    detail?: string;
    price?: string;
}

export type Card =
    | { type: 'booking'; rows: AgendaRow[] }
    | { type: 'reminders'; rows: AgendaRow[] }
    | { type: 'confirm'; title: string; details: Detail[]; ask: string }
    | { type: 'result'; title: string; subtitle?: string; items: ResultItem[] };

export const LIMITS = { title: 80, line: 120, rows: 12, details: 8, items: 12 } as const;

// One line of plain text: no control characters, single spaces, capped.
export function clip(value: unknown, max: number): string {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function minutesBetween(start: string, end: string): number {
    return Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
}

// null when there is nothing to show; the agent then answers in words.
export function bookingCard(store: Store, address: Address, now: Date): Card | null {
    const rows = store.bookingsFor(address.channel, address.handle)
        .filter((s) => Date.parse(s.endsAt) > now.getTime())
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
        .map((s) => {
            const minutes = minutesBetween(s.startsAt, s.endsAt);
            return { at: s.startsAt, title: clip(s.label, LIMITS.line) || 'Appointment', meta: minutes > 0 ? `${minutes} min` : undefined };
        });
    return rows.length ? { type: 'booking', rows } : null;
}

export function remindersCard(store: Store, address: Address): Card | null {
    const rows = store.listReminders(address.channel, address.handle)
        .map((r) => ({ at: r.dueAt, title: clip(r.text, LIMITS.line) || 'Reminder' }));
    return rows.length ? { type: 'reminders', rows } : null;
}

export function confirmCard(raw: { title?: unknown; details?: unknown; ask?: unknown }): Card | null {
    const title = clip(raw.title, LIMITS.title);
    const details = (Array.isArray(raw.details) ? raw.details : [])
        .map((d) => (d && typeof d === 'object' ? { label: clip((d as Detail).label, 30), value: clip((d as Detail).value, LIMITS.line) } : null))
        .filter((d): d is Detail => Boolean(d && d.label && d.value))
        .slice(0, LIMITS.details);
    if (!title || !details.length) return null;
    return { type: 'confirm', title, details, ask: clip(raw.ask, LIMITS.line) || 'Reply YES to confirm' };
}

export function resultCard(raw: { title?: unknown; subtitle?: unknown; items?: unknown }): Card | null {
    const title = clip(raw.title, LIMITS.title);
    const items = (Array.isArray(raw.items) ? raw.items : [])
        .map((i) => {
            if (!i || typeof i !== 'object') return null;
            const item = i as Record<string, unknown>;
            const out: ResultItem = { name: clip(item.name, LIMITS.line) };
            const detail = clip(item.detail, LIMITS.line);
            const price = clip(item.price, 20);
            if (detail) out.detail = detail;
            if (price) out.price = price;
            return out;
        })
        .filter((i): i is ResultItem => Boolean(i && i.name))
        .slice(0, LIMITS.items);
    if (!title || !items.length) return null;
    const subtitle = clip(raw.subtitle, LIMITS.line);
    return { type: 'result', title, items, ...(subtitle ? { subtitle } : {}) };
}

// What the conversation log says was sent.
export function captionFor(card: Card): string {
    switch (card.type) {
        case 'booking': return 'Your bookings';
        case 'reminders': return 'Your reminders';
        case 'confirm': return card.title;
        case 'result': return card.title;
    }
}
