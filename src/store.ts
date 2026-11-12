// src/store.ts
// Everything the agent server remembers, in one SQLite file (node:sqlite, no
// native build step). Tables:
//   contacts   one row per conversation per channel: opt-out, handoff, last
//              line. An iMessage group chat is one row, keyed by its chat id.
//   messages   the conversation log the agent reads its history from; group
//              messages keep who wrote them, and any attachments ride along
//   seen       inbound message ids already handled (bridges retry, so dedupe)
//   reminders  texts the agent promised to send later
//   slots      bookable appointment slots the operator publishes
//   browse     browser-worker tasks started on a person's behalf

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Attachment, ChannelId } from './channels/types.ts';

export interface Contact {
    channel: ChannelId;
    handle: string;
    line: string | null;
    thread: string | null;
    optedOut: boolean;
    handoffSince: string | null;
    handoffReason: string | null;
    operatorThread: string | null;
    isGroup: boolean;
    // Set when the agent left a group chat for good ('sms').
    leftReason: string | null;
}

export interface StoredMessage {
    direction: 'in' | 'out' | 'operator';
    text: string;
    createdAt: string;
    // Group chats: the member who wrote an inbound message.
    sender: string | null;
    attachments: Attachment[];
}

export interface Reminder {
    id: number;
    channel: ChannelId;
    handle: string;
    text: string;
    dueAt: string;
    attempts: number;
}

export interface Slot {
    id: number;
    startsAt: string;
    endsAt: string;
    label: string;
    bookedBy: string | null;
}

export interface BrowseTask {
    id: string;
    channel: ChannelId;
    handle: string;
    goal: string;
    status: string;
    result: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
    channel TEXT NOT NULL,
    handle TEXT NOT NULL,
    line TEXT,
    thread TEXT,
    opted_out INTEGER NOT NULL DEFAULT 0,
    handoff_since TEXT,
    handoff_reason TEXT,
    operator_thread TEXT,
    first_seen TEXT NOT NULL,
    is_group INTEGER NOT NULL DEFAULT 0,
    left_reason TEXT,
    PRIMARY KEY (channel, handle)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    handle TEXT NOT NULL,
    direction TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sender TEXT,
    attachments TEXT
);
CREATE INDEX IF NOT EXISTS messages_by_contact ON messages (channel, handle, id);
CREATE TABLE IF NOT EXISTS seen (
    external_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    handle TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    booked_channel TEXT,
    booked_handle TEXT,
    booked_note TEXT,
    booked_at TEXT
);
CREATE TABLE IF NOT EXISTS browse (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    handle TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

// Columns added after the first release, so an existing database file keeps working.
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
    ['contacts', 'is_group', 'INTEGER NOT NULL DEFAULT 0'],
    ['contacts', 'left_reason', 'TEXT'],
    ['messages', 'sender', 'TEXT'],
    ['messages', 'attachments', 'TEXT'],
];

type Row = Record<string, unknown>;

function toContact(row: Row): Contact {
    return {
        channel: row.channel as ChannelId,
        handle: String(row.handle),
        line: (row.line as string | null) ?? null,
        thread: (row.thread as string | null) ?? null,
        optedOut: Number(row.opted_out) === 1,
        handoffSince: (row.handoff_since as string | null) ?? null,
        handoffReason: (row.handoff_reason as string | null) ?? null,
        operatorThread: (row.operator_thread as string | null) ?? null,
        isGroup: Number(row.is_group) === 1,
        leftReason: (row.left_reason as string | null) ?? null,
    };
}

function toAttachments(value: unknown): Attachment[] {
    if (typeof value !== 'string' || !value) return [];
    try {
        return JSON.parse(value) as Attachment[];
    } catch {
        return [];
    }
}

export function openStore(path: string, now: () => Date = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    for (const [table, column, definition] of ADDED_COLUMNS) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
        if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    const iso = () => now().toISOString();

    return {
        close: () => db.close(),

        // ---- dedupe ----
        // True the first time an id is claimed, false after.
        claim(externalId: string): boolean {
            const result = db.prepare('INSERT OR IGNORE INTO seen (external_id, created_at) VALUES (?, ?)').run(externalId, iso());
            return Number(result.changes) === 1;
        },

        // ---- contacts ----
        touchContact(address: Address): Contact {
            db.prepare(`INSERT INTO contacts (channel, handle, line, thread, first_seen, is_group) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (channel, handle) DO UPDATE SET
                    line = COALESCE(excluded.line, contacts.line),
                    thread = COALESCE(excluded.thread, contacts.thread),
                    is_group = MAX(contacts.is_group, excluded.is_group)`)
                .run(address.channel, address.handle, address.line ?? null, address.thread ?? null, iso(), address.group ? 1 : 0);
            return this.getContact(address.channel, address.handle)!;
        },
        getContact(channel: ChannelId, handle: string): Contact | null {
            const row = db.prepare('SELECT * FROM contacts WHERE channel = ? AND handle = ?').get(channel, handle) as Row | undefined;
            return row ? toContact(row) : null;
        },
        findByOperatorThread(threadRef: string): Contact | null {
            const row = db.prepare('SELECT * FROM contacts WHERE operator_thread = ?').get(threadRef) as Row | undefined;
            return row ? toContact(row) : null;
        },
        setOptOut(channel: ChannelId, handle: string, optedOut: boolean): void {
            db.prepare('UPDATE contacts SET opted_out = ? WHERE channel = ? AND handle = ?').run(optedOut ? 1 : 0, channel, handle);
        },
        startHandoff(channel: ChannelId, handle: string, reason: string): void {
            db.prepare('UPDATE contacts SET handoff_since = ?, handoff_reason = ? WHERE channel = ? AND handle = ?').run(iso(), reason, channel, handle);
        },
        setOperatorThread(channel: ChannelId, handle: string, threadRef: string): void {
            db.prepare('UPDATE contacts SET operator_thread = ? WHERE channel = ? AND handle = ?').run(threadRef, channel, handle);
        },
        leaveGroup(channel: ChannelId, handle: string, reason: string): void {
            db.prepare('UPDATE contacts SET left_reason = ? WHERE channel = ? AND handle = ? AND is_group = 1').run(reason, channel, handle);
        },
        endHandoff(channel: ChannelId, handle: string): void {
            db.prepare('UPDATE contacts SET handoff_since = NULL, handoff_reason = NULL, operator_thread = NULL WHERE channel = ? AND handle = ?').run(channel, handle);
        },

        // ---- messages ----
        addMessage(channel: ChannelId, handle: string, direction: StoredMessage['direction'], text: string, extra: { sender?: string; attachments?: Attachment[] } = {}): void {
            const attachments = extra.attachments?.length ? JSON.stringify(extra.attachments) : null;
            db.prepare('INSERT INTO messages (channel, handle, direction, text, created_at, sender, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(channel, handle, direction, text, iso(), extra.sender ?? null, attachments);
        },
        recentMessages(channel: ChannelId, handle: string, limit: number): StoredMessage[] {
            const rows = db.prepare('SELECT direction, text, created_at, sender, attachments FROM messages WHERE channel = ? AND handle = ? ORDER BY id DESC LIMIT ?').all(channel, handle, limit) as Row[];
            return rows.reverse().map((row) => ({
                direction: row.direction as StoredMessage['direction'],
                text: String(row.text),
                createdAt: String(row.created_at),
                sender: (row.sender as string | null) ?? null,
                attachments: toAttachments(row.attachments),
            }));
        },
        outboundSince(channel: ChannelId, handle: string, sinceIso: string): number {
            const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND handle = ? AND direction = 'out' AND created_at >= ?").get(channel, handle, sinceIso) as Row;
            return Number(row.n);
        },

        // ---- reminders ----
        addReminder(channel: ChannelId, handle: string, text: string, dueAt: string): number {
            const result = db.prepare('INSERT INTO reminders (channel, handle, text, due_at) VALUES (?, ?, ?, ?)').run(channel, handle, text, dueAt);
            return Number(result.lastInsertRowid);
        },
        listReminders(channel: ChannelId, handle: string): Reminder[] {
            const rows = db.prepare('SELECT * FROM reminders WHERE channel = ? AND handle = ? AND sent_at IS NULL AND cancelled = 0 ORDER BY due_at').all(channel, handle) as Row[];
            return rows.map(toReminder);
        },
        cancelReminder(channel: ChannelId, handle: string, id: number): boolean {
            const result = db.prepare('UPDATE reminders SET cancelled = 1 WHERE id = ? AND channel = ? AND handle = ? AND sent_at IS NULL').run(id, channel, handle);
            return Number(result.changes) === 1;
        },
        dueReminders(maxAttempts: number): Reminder[] {
            const rows = db.prepare('SELECT * FROM reminders WHERE sent_at IS NULL AND cancelled = 0 AND due_at <= ? AND attempts < ? ORDER BY due_at LIMIT 50').all(iso(), maxAttempts) as Row[];
            return rows.map(toReminder);
        },
        markReminderSent(id: number): void {
            db.prepare('UPDATE reminders SET sent_at = ? WHERE id = ?').run(iso(), id);
        },
        markReminderFailed(id: number): void {
            db.prepare('UPDATE reminders SET attempts = attempts + 1 WHERE id = ?').run(id);
        },

        // ---- slots ----
        // Times are stored as UTC ISO strings so they compare as text.
        addSlot(startsAt: string, endsAt: string, label: string): number {
            const start = new Date(startsAt);
            const end = new Date(endsAt);
            if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error('slot needs a valid start before its end');
            const result = db.prepare('INSERT INTO slots (starts_at, ends_at, label) VALUES (?, ?, ?)').run(start.toISOString(), end.toISOString(), label);
            return Number(result.lastInsertRowid);
        },
        openSlots(fromIso: string, limit: number): Slot[] {
            const rows = db.prepare('SELECT * FROM slots WHERE booked_handle IS NULL AND starts_at >= ? ORDER BY starts_at LIMIT ?').all(fromIso, limit) as Row[];
            return rows.map(toSlot);
        },
        allSlots(): Slot[] {
            return (db.prepare('SELECT * FROM slots ORDER BY starts_at').all() as Row[]).map(toSlot);
        },
        bookingsFor(channel: ChannelId, handle: string): Slot[] {
            const rows = db.prepare('SELECT * FROM slots WHERE booked_channel = ? AND booked_handle = ? ORDER BY starts_at').all(channel, handle) as Row[];
            return rows.map(toSlot);
        },
        // Atomic: only one person can take a slot.
        book(id: number, channel: ChannelId, handle: string, note: string): boolean {
            const result = db.prepare('UPDATE slots SET booked_channel = ?, booked_handle = ?, booked_note = ?, booked_at = ? WHERE id = ? AND booked_handle IS NULL AND starts_at >= ?')
                .run(channel, handle, note, iso(), id, iso());
            return Number(result.changes) === 1;
        },
        cancelBooking(id: number, channel: ChannelId, handle: string): boolean {
            const result = db.prepare('UPDATE slots SET booked_channel = NULL, booked_handle = NULL, booked_note = NULL, booked_at = NULL WHERE id = ? AND booked_channel = ? AND booked_handle = ?')
                .run(id, channel, handle);
            return Number(result.changes) === 1;
        },

        // ---- browser tasks ----
        addBrowseTask(task: Omit<BrowseTask, 'result'>): void {
            db.prepare('INSERT INTO browse (id, channel, handle, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(task.id, task.channel, task.handle, task.goal, task.status, iso(), iso());
        },
        getBrowseTask(id: string): BrowseTask | null {
            const row = db.prepare('SELECT * FROM browse WHERE id = ?').get(id) as Row | undefined;
            if (!row) return null;
            return { id: String(row.id), channel: row.channel as ChannelId, handle: String(row.handle), goal: String(row.goal), status: String(row.status), result: (row.result as string | null) ?? null };
        },
        activeBrowseTasks(channel: ChannelId, handle: string): number {
            const row = db.prepare("SELECT COUNT(*) AS n FROM browse WHERE channel = ? AND handle = ? AND status = 'running'").get(channel, handle) as Row;
            return Number(row.n);
        },
        finishBrowseTask(id: string, status: string, result: string): boolean {
            const res = db.prepare("UPDATE browse SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(status, result, iso(), id);
            return Number(res.changes) === 1;
        },
    };
}

function toReminder(row: Row): Reminder {
    return { id: Number(row.id), channel: row.channel as ChannelId, handle: String(row.handle), text: String(row.text), dueAt: String(row.due_at), attempts: Number(row.attempts) };
}

function toSlot(row: Row): Slot {
    return {
        id: Number(row.id),
        startsAt: String(row.starts_at),
        endsAt: String(row.ends_at),
        label: String(row.label ?? ''),
        bookedBy: row.booked_handle ? `${row.booked_channel}:${row.booked_handle}` : null,
    };
}

export type Store = ReturnType<typeof openStore>;
