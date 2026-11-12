// bridges/mac/watcher.ts
// Inbound for the Mac line: reads new rows from ~/Library/Messages/chat.db
// (read-only) and forwards what people sent to the agent server: texts,
// photos and voice notes (as links to this bridge's /attachment route), group
// messages (from = the sender, chat = the group), and inline replies.
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
// ATTACHMENT SETTLE. chat.db names a file before Messages has finished
// downloading it (transfer_state 5 means done). A row whose files are not on
// disk yet holds the cursor for up to ATTACHMENT_WAIT_MS, so a text sent after
// a photo cannot overtake it; after that it goes with whatever arrived.
//
// TEXT. message.text is cleared a few seconds after the row is written; the
// words survive in attributedBody (attributed-body.ts).
//
// COLUMNS. Older macOS versions lack some columns (thread_originator_guid
// arrived with inline replies); a missing one reads as NULL.

import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { attributedBodyText } from './attributed-body.ts';
import { mimeFor } from '../attachments.ts';
import type { InboundAttachment } from '../attachments.ts';
import type { Forwarder, InboundPayload } from '../forward.ts';

export const SETTLE_TRIES = 20;
export const ATTACHMENT_WAIT_MS = 24_000;
const BATCH = 100;
const TRANSFER_DONE = 5;

const OPTIONAL_COLUMNS: Record<string, string> = {
    cache_has_attachments: 'hasAttachments',
    is_audio_message: 'isAudio',
    thread_originator_guid: 'threadOriginatorGuid',
};

function columnsOf(db: DatabaseSync, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
}

function messageQuery(db: DatabaseSync): string {
    const present = columnsOf(db, 'message');
    const optional = Object.entries(OPTIONAL_COLUMNS)
        .map(([column, alias]) => (present.has(column) ? `message.${column} AS ${alias}` : `NULL AS ${alias}`))
        .join(',\n        ');
    return `
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
        ${optional},
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
}

const ATTACHMENT_QUERY = `
    SELECT attachment.filename AS localPath, attachment.transfer_name AS fileName,
        attachment.mime_type AS mimeType, attachment.transfer_state AS transferState
    FROM attachment
    JOIN message_attachment_join ON message_attachment_join.attachment_id = attachment.ROWID
    WHERE message_attachment_join.message_id = ?
    ORDER BY attachment.ROWID ASC
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
    hasAttachments?: number | null;
    isAudio?: number | null;
    threadOriginatorGuid?: string | null;
    participant: string | null;
    chatId: string | null;
    chatStyle: number | null;
}

export interface AttachmentRow {
    localPath: string | null;
    fileName: string | null;
    mimeType: string | null;
    transferState: number | null;
}

export function rowText(row: Pick<WatcherRow, 'text' | 'attributedBody'>): string {
    return (row.text || attributedBodyText(row.attributedBody) || '').replace(/\uFFFC/g, '').trim();
}

// chat.style 43 is a group chat in Messages' schema; 45 is one-to-one.
export function isGroupRow(row: Pick<WatcherRow, 'chatStyle' | 'chatId'>): boolean {
    return row.chatStyle === 43 || /^chat\d+/.test(row.chatId ?? '');
}

// May carry files: the flag, a voice note, or an attachment glyph in the text.
export function expectsAttachments(row: Pick<WatcherRow, 'hasAttachments' | 'isAudio' | 'text' | 'attributedBody'>): boolean {
    return row.hasAttachments === 1 || row.isAudio === 1 || /\uFFFC/.test(row.text || attributedBodyText(row.attributedBody) || '');
}

// What a person sent: not ours, not system rows, not tapbacks, not app cards
// (games, Apple Pay and so on). Words, files, or both. A shared link is a
// balloon too (the rich preview), but its URL is the text, so it is kept.
export function isLinkBalloon(id: string | null): boolean {
    return Boolean(id && id.includes('URLBalloonProvider'));
}

export function isForwardable(row: WatcherRow): boolean {
    return row.isFromMe !== 1 && !row.itemType && !row.associatedType && (!row.balloonBundleId || isLinkBalloon(row.balloonBundleId)) && Boolean(row.participant)
        && (Boolean(rowText(row)) || expectsAttachments(row));
}

export function expandHome(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export interface WatcherState {
    cursor: number;
}

export interface WatcherOptions {
    db: DatabaseSync;
    line: string;
    forward: Forwarder;
    state: WatcherState;
    save: (state: WatcherState) => void;
    log: (message: string) => void;
    // The link the server fetches a file by (the bridge's /attachment route).
    attachmentUrl?: (localPath: string) => string;
    fileExists?: (path: string) => boolean;
    now?: () => number;
}

export function createWatcher(options: WatcherOptions) {
    const { db, line, forward, state, save, log } = options;
    const fileExists = options.fileExists ?? existsSync;
    const now = options.now ?? Date.now;
    const attachmentUrl = options.attachmentUrl ?? ((path: string) => path);
    const query = db.prepare(messageQuery(db));
    const hasAttachmentTables = columnsOf(db, 'attachment').size > 0 && columnsOf(db, 'message_attachment_join').size > 0;
    const attachmentQuery = hasAttachmentTables ? db.prepare(ATTACHMENT_QUERY) : null;
    const replyQuery = columnsOf(db, 'message').has('thread_originator_guid')
        ? db.prepare('SELECT text, attributedBody, is_from_me AS isFromMe FROM message WHERE guid = ? LIMIT 1')
        : null;
    const settleTries = new Map<number, number>();
    const attachmentWaitSince = new Map<number, number>();
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

    // The row's files as links, or null while they are still arriving.
    function attachmentsFor(row: WatcherRow): InboundAttachment[] | null {
        if (!attachmentQuery || !expectsAttachments(row)) return [];
        const files = attachmentQuery.all(row.rowId) as unknown as AttachmentRow[];
        const ready = files.filter((file) => file.localPath && file.transferState === TRANSFER_DONE && fileExists(expandHome(file.localPath)));
        const waitingSince = attachmentWaitSince.get(row.rowId) ?? now();
        if ((ready.length < files.length || !files.length) && now() - waitingSince < ATTACHMENT_WAIT_MS) {
            attachmentWaitSince.set(row.rowId, waitingSince);
            return null;
        }
        attachmentWaitSince.delete(row.rowId);
        if (ready.length < files.length || !files.length) log(`row ${row.rowId}: ${files.length - ready.length} attachment(s) never arrived; forwarding what did`);
        return ready.map((file) => {
            const path = expandHome(file.localPath!);
            const fileName = file.fileName || basename(path);
            return { url: attachmentUrl(path), mimeType: file.mimeType || mimeFor(fileName), fileName };
        });
    }

    function replyToFor(row: WatcherRow): InboundPayload['replyTo'] {
        if (!replyQuery || !row.threadOriginatorGuid) return undefined;
        const guid = row.threadOriginatorGuid.replace(/^p:\d+\//, '');
        const target = replyQuery.get(guid) as { text: string | null; attributedBody: Uint8Array | null; isFromMe: number } | undefined;
        return target ? { guid, text: rowText(target), isFromMe: target.isFromMe === 1 } : undefined;
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
                        const attachments = attachmentsFor(row);
                        if (!attachments) return forwarded;
                        const text = rowText(row);
                        if (text || attachments.length) {
                            const payload: InboundPayload = { line, from: row.participant!, text, guid: row.guid, isGroup: isGroupRow(row), service: row.service ?? undefined };
                            if (row.chatId) payload.chat = row.chatId;
                            if (attachments.length) payload.attachments = attachments;
                            const replyTo = replyToFor(row);
                            if (replyTo) payload.replyTo = replyTo;
                            const result = await forward(payload);
                            if (result === 'retry') return forwarded;
                            if (result === 'refused') log(`server refused row ${row.rowId}; skipping it`);
                            else forwarded += 1;
                        }
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
