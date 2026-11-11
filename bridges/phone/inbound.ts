// bridges/phone/inbound.ts
// Inbound for an iPhone line: every text a person sends reaches the agent
// server once, in order, and nothing older ever replays.
//
// CURSORS. Each chat has a cursor (the highest ROWID handled). A chat with no
// cursor of its own starts at the FLOOR: the newest row on the phone when the
// bridge first started, so a chat that was quiet then cannot replay old texts
// when it wakes up.
//
// WHEN TO LOOK. Each pass reads the chat list and only reads rows for chats
// whose marker (time, unread flag, latest text) moved, plus every chat once a
// minute (sms.db dates are the sender's clock, so a late text can leave the
// marker unchanged). Reading every chat every poll costs the phone real CPU.
//
// FAILURES stay with their chat: if the server cannot take a text, that chat
// stops for this pass and tries again next pass; other chats carry on.

import type { SmsRow } from './smserver.ts';
import { asRowId, isFromMe } from './smserver.ts';

export const FULL_SCAN_MS = 60_000;

export interface InboundState {
    floor: number;
    cursors: Record<string, number>;
    markers: Record<string, string>;
    lastFullScan: number;
}

export function emptyState(): InboundState {
    return { floor: 0, cursors: {}, markers: {}, lastFullScan: 0 };
}

// Texts in a chat that still need forwarding, oldest first.
export function pendingRows(state: InboundState, chat: string, rows: SmsRow[]): SmsRow[] {
    const cursor = state.cursors[chat] ?? state.floor;
    return rows
        .filter((row) => asRowId(row.ROWID) > cursor)
        .sort((a, b) => asRowId(a.ROWID) - asRowId(b.ROWID));
}

// A plain text from a person: not ours, not a system row, not a tapback or app card.
export function isForwardable(row: SmsRow): boolean {
    const type = row.item_type;
    const systemRow = !(type == null || type === '' || type === 0 || type === '0');
    const appCard = typeof row.balloon_bundle_id === 'string' && row.balloon_bundle_id !== '';
    const tapback = asRowId(row.associated_message_type) !== 0;
    return !isFromMe(row) && !systemRow && !appCard && !tapback && typeof row.text === 'string' && row.text.trim() !== '';
}

export function settle(state: InboundState, chat: string, row: SmsRow): void {
    state.cursors[chat] = Math.max(state.cursors[chat] ?? state.floor, asRowId(row.ROWID));
}

// Which chats to read this pass.
export function chatsToRead(state: InboundState, listed: Array<{ chat: string; marker: string }>, now: number): string[] {
    const full = now - state.lastFullScan >= FULL_SCAN_MS;
    return listed.filter((entry) => full || state.markers[entry.chat] !== entry.marker).map((entry) => entry.chat);
}

// The sender of a row in a 1:1 chat is the chat id itself. Group chats on
// SMServer are "chat<digits>" ids.
export function isGroupChat(chat: string): boolean {
    return /^chat\d+/.test(chat);
}
