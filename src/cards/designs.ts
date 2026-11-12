// src/cards/designs.ts
// How a card looks: one self-contained HTML page per card, drawn by Chrome
// and screenshotted by src/cards/render.ts.
//
// These are the production card designs, at picture size:
//   booking, reminders, confirm   the "daily" layout: a big title, one muted
//                                 line under it, a status pill, then an agenda
//                                 (day label, time column, accent bar, title)
//   result                        a tinted header with the headline, then rows
//                                 (name, detail, price) and a quiet footer
// Light by default, as in production; CARD_THEME=dark gives the iMessage-black
// version. Each card has its own accent: bookings blue, reminders indigo,
// confirm orange, results teal.
//
// Every value that came from a person, the model or a web page is escaped.
// The page has no scripts and loads nothing, so nothing on it can run.

import type { AgendaRow, Card } from './cards.ts';

export type CardTheme = 'light' | 'dark';

export interface DesignOptions {
    theme: CardTheme;
    timeZone: string;
    now: Date;
}

// Picture widths. iMessage sizes the bubble by shape, not pixels, so a
// narrower picture shows larger in the thread.
const WIDE = 660;
const TALL = 480;
const MAX_ROWS_SHOWN = 6;
const MAX_ITEMS_SHOWN = 5;

export function esc(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---- time words, in the business's time zone ----------------------------------

function timeStr(at: Date, timeZone: string): string {
    return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
}

function dayKey(at: Date, timeZone: string): string {
    return at.toLocaleDateString('en-CA', { timeZone });
}

// Today, Tomorrow, then "Sat, Sep 13".
function dayLabel(at: Date, o: DesignOptions): string {
    const key = dayKey(at, o.timeZone);
    if (key === dayKey(o.now, o.timeZone)) return 'Today';
    if (key === dayKey(new Date(o.now.getTime() + 86_400_000), o.timeZone)) return 'Tomorrow';
    return at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: o.timeZone });
}

// "in 25m", "in 3h"; only used within three hours.
function soonLabel(at: Date, now: Date): string {
    const mins = Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000));
    return mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`;
}

function nextUp(rows: AgendaRow[], o: DesignOptions): string {
    const at = new Date(rows[0].at);
    const when = at.getTime() - o.now.getTime() < 3 * 3_600_000
        ? soonLabel(at, o.now)
        : `${dayLabel(at, o)} ${timeStr(at, o.timeZone)}`;
    return `Next up ${rows[0].title} · ${when}`;
}

// ---- shared pieces --------------------------------------------------------------

function head(title: string, sub: string, pill: string, pillGood = false): string {
    return `<div class="k3-head"><div class="k3-lead"><div class="k3-title">${esc(title)}</div>`
        + (sub ? `<div class="k3-sub">${esc(sub)}</div>` : '')
        + `</div><span class="k3-pill${pillGood ? ' good' : ''}">${esc(pill)}</span></div>`;
}

// Rows under a day label that repeats only when the day changes.
function agenda(rows: AgendaRow[], o: DesignOptions): string {
    const shown = rows.slice(0, MAX_ROWS_SHOWN);
    let html = '';
    let lastDay = '';
    for (const row of shown) {
        const at = new Date(row.at);
        const day = dayKey(at, o.timeZone);
        if (day !== lastDay) {
            html += `<div class="k3-sec"><span>${esc(dayLabel(at, o))}</span></div>`;
            lastDay = day;
        }
        const soon = at.getTime() - o.now.getTime() < 3 * 3_600_000;
        html += '<div class="ag-row">'
            + `<span class="ag-time">${esc(timeStr(at, o.timeZone))}</span>`
            + '<span class="ag-bar"></span>'
            + `<span class="ag-title">${esc(row.title)}</span>`
            + (soon ? `<span class="t-chip">${esc(soonLabel(at, o.now))}</span>` : row.meta ? `<span class="ag-meta">${esc(row.meta)}</span>` : '')
            + '</div>';
    }
    const hidden = rows.length - shown.length;
    if (hidden > 0) html += `<div class="k3-foot"><span>Showing <b>${shown.length}</b> of <b>${rows.length}</b></span></div>`;
    return html;
}

// ---- the four cards -----------------------------------------------------------------

function bookingHtml(rows: AgendaRow[], o: DesignOptions): string {
    return `<section id="card" class="kard k3 acc-booking">${head('Your bookings', nextUp(rows, o), `${rows.length} booked`)}${agenda(rows, o)}</section>`;
}

function remindersHtml(rows: AgendaRow[], o: DesignOptions): string {
    return `<section id="card" class="kard k3 acc-reminders">${head('Reminders', nextUp(rows, o), `${rows.length} coming up`)}${agenda(rows, o)}</section>`;
}

function confirmHtml(card: Extract<Card, { type: 'confirm' }>): string {
    const rows = card.details.map((d) => `<div class="cf-row"><span class="cf-label">${esc(d.label)}</span><span class="cf-value">${esc(d.value)}</span></div>`).join('');
    return `<section id="card" class="kard k3 acc-confirm">${head(card.title, card.ask, 'Waiting on you')}`
        + `<div class="k3-sec"><span>Details</span></div>${rows}`
        + '<div class="k3-foot"><span>Nothing happens until you reply</span></div></section>';
}

function resultHtml(card: Extract<Card, { type: 'result' }>): string {
    const shown = card.items.slice(0, MAX_ITEMS_SHOWN);
    const rows = shown.map((item, i) => '<div class="rs-row">'
        + `<span class="rs-num">${i + 1}</span>`
        + `<span class="rs-body"><span class="rs-name">${esc(item.name)}</span>${item.detail ? `<span class="rs-detail">${esc(item.detail)}</span>` : ''}</span>`
        + (item.price ? `<span class="rs-price">${esc(item.price)}</span>` : '')
        + '</div>').join('');
    const more = card.items.length - shown.length;
    const count = `${card.items.length} ${card.items.length === 1 ? 'pick' : 'picks'} from a web task`;
    return '<section id="card" class="kard has-art acc-result">'
        + '<div class="k-art"><div class="k-art-top"><span class="k-title">Found</span><span class="k-pill-v2">From the web</span></div>'
        + `<div class="k-art-big">${esc(card.title)}</div>${card.subtitle ? `<div class="k-art-mid">${esc(card.subtitle)}</div>` : ''}</div>`
        + `<div class="k-body">${rows}${more > 0 ? `<p class="rs-more">+${more} more</p>` : ''}`
        + `<div class="k-band2"><span>${esc(count)}</span></div></div></section>`;
}

// ---- styles ---------------------------------------------------------------------------

const CSS = `
:root {
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --bg:
    radial-gradient(80% 46% at 50% -6%, rgba(150, 185, 255, .50), transparent 60%),
    radial-gradient(54% 38% at 90% 18%, rgba(158, 198, 255, .40), transparent 58%),
    radial-gradient(52% 44% at 6% 82%, rgba(150, 205, 255, .38), transparent 60%),
    linear-gradient(180deg, #f6f9ff 0%, #e9f0fb 50%, #dbe6f7 100%);
  --kard-bg: linear-gradient(180deg, rgba(255, 255, 255, .90) 0%, rgba(255, 255, 255, .66) 100%);
  --text: #1a1f2e;
  --text-soft: rgba(26, 31, 46, .62);
  --text-mut: rgba(26, 31, 46, .42);
  --hair: rgba(26, 31, 46, .07);
  --chip: rgba(26, 31, 46, .06);
  --green-bg: rgba(48, 209, 88, .14); --green-ink: #1d9e43;
  --blue-bg: rgba(10, 132, 255, .12); --blue-ink: #0a6ce0;
}
:root[data-theme="dark"] {
  --bg: #000000;
  --kard-bg: #1d1d1d;
  --text: #ffffff;
  --text-soft: rgba(255, 255, 255, .64);
  --text-mut: rgba(255, 255, 255, .40);
  --hair: rgba(255, 255, 255, .07);
  --chip: rgba(255, 255, 255, .08);
  --green-bg: rgba(48, 209, 88, .18); --green-ink: #5be27f;
  --blue-bg: rgba(10, 132, 255, .18); --blue-ink: #64a8ff;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); font-family: var(--font); color: var(--text); -webkit-font-smoothing: antialiased; }

.acc-booking   { --acc: #0a84ff; --wash: rgba(10, 132, 255, .12);  --acc-ink: #0a6ce0; }
.acc-reminders { --acc: #6366f1; --wash: rgba(99, 102, 241, .13);  --acc-ink: #4338ca; }
.acc-confirm   { --acc: #ff9f0a; --wash: rgba(255, 159, 10, .14);  --acc-ink: #c46b00; }
.acc-result    { --acc: #0ea5a4; --wash: rgba(14, 165, 164, .14);  --acc-ink: #0f766e; }
:root[data-theme="dark"] .acc-booking   { --acc-ink: #64a8ff; }
:root[data-theme="dark"] .acc-reminders { --acc-ink: #a5b4fc; }
:root[data-theme="dark"] .acc-confirm   { --acc-ink: #ffb340; }
:root[data-theme="dark"] .acc-result    { --acc-ink: #5eead4; }

.kard { position: relative; width: 100%; color: var(--text); background: var(--kard-bg); }

/* Daily layout */
.kard.k3 { padding: 30px 32px 26px; background: linear-gradient(160deg, var(--wash) 0%, rgba(0, 0, 0, 0) 46%), var(--kard-bg); }
.k3-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.k3-lead { min-width: 0; flex: 1 1 auto; }
.k3-title { font-size: 42px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.05; }
.k3-sub { margin-top: 8px; font-size: 19px; font-weight: 500; line-height: 1.3; color: var(--text-mut); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.k3-pill { flex-shrink: 0; margin-top: 8px; padding: 9px 16px; border-radius: 999px; background: var(--chip); color: var(--text-soft); font-size: 15.5px; font-weight: 650; white-space: nowrap; }
.k3-pill.good { background: var(--green-bg); color: var(--green-ink); }
.k3-sec { margin-top: 24px; padding-bottom: 8px; border-bottom: 1px solid var(--hair); font-size: 12.5px; font-weight: 750; text-transform: uppercase; letter-spacing: .1em; color: var(--text-mut); }
.k3-foot { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--hair); font-size: 15.5px; font-weight: 600; color: var(--text-mut); }
.k3-foot b { font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; }

.ag-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--hair); }
.k3-sec + .ag-row, .k3-sec + .cf-row { border-top: 0; }
.ag-time { flex-shrink: 0; width: 84px; font-size: 16.5px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-soft); white-space: nowrap; }
.ag-bar { flex-shrink: 0; width: 4px; height: 32px; border-radius: 2px; background: var(--acc); }
.ag-title { flex: 1 1 auto; min-width: 0; font-size: 19px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-meta { flex-shrink: 0; font-size: 15px; font-weight: 600; color: var(--text-mut); white-space: nowrap; }
.t-chip { flex-shrink: 0; padding: 5px 11px; border-radius: 999px; background: var(--green-bg); color: var(--green-ink); font-size: 13px; font-weight: 700; white-space: nowrap; }

.cf-row { display: flex; align-items: baseline; gap: 16px; padding: 14px 0; border-top: 1px solid var(--hair); }
.cf-label { flex-shrink: 0; width: 120px; font-size: 15px; font-weight: 700; color: var(--text-mut); }
.cf-value { flex: 1 1 auto; min-width: 0; font-size: 19px; font-weight: 650; overflow-wrap: anywhere; }

/* Result layout: a tinted header field, then rows */
.kard.has-art { padding: 26px 26px 24px; }
.k-art { margin: -26px -26px 0; padding: 26px 26px 16px; background: linear-gradient(180deg, var(--wash) 0%, var(--wash) 38%, rgba(0, 0, 0, 0) 100%); }
.k-art-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.k-title { min-width: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.k-pill-v2 { flex-shrink: 0; padding: 5px 10px; border-radius: 999px; background: var(--chip); color: var(--text-soft); font-size: 12.5px; font-weight: 650; white-space: nowrap; }
.k-art-big { margin-top: 18px; font-size: 36px; font-weight: 800; line-height: 1.12; letter-spacing: -0.02em; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; text-wrap: balance; }
.k-art-mid { margin-top: 6px; font-size: 15px; font-weight: 600; color: var(--text-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.k-body { padding: 18px 0 0; }
.rs-row { display: flex; align-items: center; gap: 12px; padding: 11px 2px; }
.rs-row + .rs-row { border-top: 1px solid var(--hair); }
.rs-num { flex-shrink: 0; width: 40px; height: 40px; border-radius: 12px; background: var(--wash); color: var(--acc-ink); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 800; }
.rs-body { flex: 1; min-width: 0; }
.rs-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 15.5px; font-weight: 650; line-height: 1.35; }
.rs-detail { display: block; margin-top: 2px; font-size: 13px; color: var(--text-mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-price { flex-shrink: 0; font-size: 15.5px; font-weight: 700; white-space: nowrap; }
.rs-more { margin: 6px 0 0; font-size: 13px; color: var(--text-mut); }
.k-band2 { display: flex; align-items: center; margin-top: 8px; padding: 12px 0 2px; border-top: 1px solid var(--hair); font-size: 13px; font-weight: 650; color: var(--text-soft); }
`;

export function cardWidth(card: Card): number {
    return card.type === 'result' ? TALL : WIDE;
}

// The whole page. The picture is the element with id="card".
export function cardDocument(card: Card, options: DesignOptions): string {
    let body: string;
    switch (card.type) {
        case 'booking': body = bookingHtml(card.rows, options); break;
        case 'reminders': body = remindersHtml(card.rows, options); break;
        case 'confirm': body = confirmHtml(card); break;
        case 'result': body = resultHtml(card); break;
    }
    return `<!doctype html><html data-theme="${options.theme}"><head><meta charset="utf-8">`
        + `<style>${CSS}</style></head><body><div style="width:${cardWidth(card)}px">${body}</div></body></html>`;
}
