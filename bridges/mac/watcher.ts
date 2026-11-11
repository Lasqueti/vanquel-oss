// bridges/mac/watcher.ts
// Inbound for the Mac line: reads new rows from ~/Library/Messages/chat.db
// (read-only) and forwards texts people sent to the agent server.
//
// CURSOR. message.ROWID only goes up, so one number says what was handled.
// The cursor moves past a row only once it is settled: forwarded, refused by
// the server, or not something to forward. If the server is down the cursor
// stays put and the row is tried again on the next scan. First start sets the
// cursor at the newest row, so old history is never replayed.
//
// ROW SETTLE. Messages.app inserts a row before it attaches the sender and the
// chat. Read too early, an inbound row has neither, and guessing (for example
// from destination_caller_id, which is our OWN number) makes the agent talk to
// itself. So an inbound row with no chat waits, for at most SETTLE_TRIES scans.
//
// TEXT. message.text is cleared a few seconds after the row is written; the
// words survive in attributedBody (attributed-body.ts).

import type { DatabaseSync } from 'node:sqlite';
import { attributedBodyText } from './attributed-body.ts';
import type { Forwarder } from '../forward.ts';

export const SETTLE_TRIES = 20;
const BATCH = 100;

const MESSAGE_QUERY = `
    SELECT
        message.ROWID AS rowId,
        message.guid AS guid,
        message.text AS text,
        message.attributedBody AS attributedBody,
        message.is_from_me AS isFromMe,
        message.item_type AS itemType,
        message.service AS service,
        message.associated_message_type AS associatedType,
        message.balloon_bundle_id AS balloonBundleId,
        handle.id AS participant,
        COALESCE(chat.chat_identifier, message.cache_roomnames) AS chatId,
        chat.style AS chatStyle
    FROM message
    LEFT JOIN handle ON handle.ROWID = message.handle_id
    LEFT JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
    LEFT JOIN chat ON chat.ROWID = chat_message_join.chat_id
    WHERE message.ROWID > ?
    ORDER BY message.ROWID ASC
    LIMIT ${BATCH}
`;

export interface WatcherRow {
    rowId: number;
    guid: string;
    text: string | null;
    attributedBody: Uint8Array | null;
    isFromMe: number;
    itemType: number | null;
    service: string | null;
    associatedType: number | null;
    balloonBundleId: string | null;
    participant: string | null;
    chatId: string | null;
    chatStyle: number | null;
}

export function rowText(row: Pick<WatcherRow, 'text' | 'attributedBody'>): string {
    return (row.text || attributedBodyText(row.attributedBody) || '').replace(/\uFFFC/g, '').trim();
}

// chat.style 43 is a group chat in Messages' schema; 45 is one-to-one.
export function isGroupRow(row: Pick<WatcherRow, 'chatStyle' | 'chatId'>): boolean {
    return row.chatStyle === 43 || /^chat\d+/.test(row.chatId ?? '');
}

// Only plain texts a person sent: not ours, not system rows, not tapbacks,
// not app cards (games, Apple Pay and so on).
export function isForwardable(row: WatcherRow): boolean {
    return row.isFromMe !== 1 && !row.itemType && !row.associatedType && !row.balloonBundleId && Boolean(row.participant) && Boolean(rowText(row));
}

export interface WatcherState {
    cursor: number;
}

export function createWatcher(options: { db: DatabaseSync; line: string; forward: Forwarder; state: WatcherState; save: (state: WatcherState) => void; log: (message: string) => void }) {
    const { db, line, forward, state, save, log } = options;
    const query = db.prepare(MESSAGE_QUERY);
    const settleTries = new Map<number, number>();
    let scanning = false;

    function stillSettling(row: WatcherRow): boolean {
        if (row.isFromMe === 1 || row.chatId) {
            settleTries.delete(row.rowId);
            return false;
        }
        const tries = (settleTries.get(row.rowId) ?? 0) + 1;
        if (tries > SETTLE_TRIES) {
            settleTries.delete(row.rowId);
            log(`row ${row.rowId} never got a chat; settling it as is`);
            return false;
        }
        settleTries.set(row.rowId, tries);
        return true;
    }

    function advance(rowId: number): void {
        state.cursor = Math.max(state.cursor, rowId);
        save(state);
    }

    // Returns how many rows were forwarded.
    async function scan(): Promise<number> {
        if (scanning) return 0;
        scanning = true;
        let forwarded = 0;
        try {
            for (;;) {
                const rows = query.all(state.cursor) as unknown as WatcherRow[];
                if (!rows.length) return forwarded;
                for (const row of rows) {
                    if (stillSettling(row)) return forwarded;
                    if (isForwardable(row)) {
                        const result = await forward({ line, from: row.participant!, text: rowText(row), guid: row.guid, isGroup: isGroupRow(row), service: row.service ?? undefined });
                        if (result === 'retry') return forwarded;
                        if (result === 'refused') log(`server refused row ${row.rowId}; skipping it`);
                        else forwarded += 1;
                    }
                    advance(row.rowId);
                }
                if (rows.length < BATCH) return forwarded;
            }
        } finally {
            scanning = false;
        }
    }

    function initialize(): void {
        if (state.cursor > 0) return;
        const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS rowId FROM message').get() as { rowId: number };
        advance(Number(row.rowId));
    }

    return { scan, initialize };
}
