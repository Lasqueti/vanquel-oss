import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { attributedBodyText } from '../bridges/mac/attributed-body.ts';
import { createWatcher, isGroupRow } from '../bridges/mac/watcher.ts';
import type { InboundPayload, ForwardResult } from '../bridges/forward.ts';
import { argvSafeText, createSender, sendCommand } from '../bridges/mac/sender.ts';
import { chatsToRead, emptyState, isForwardable, pendingRows, settle } from '../bridges/phone/inbound.ts';
import { multipartForm } from '../bridges/phone/smserver.ts';
import { PERSON, OTHER } from './helpers.ts';

// ---- attributedBody: build the typedstream bytes by hand ----

function str(value: string): number[] {
    const bytes = [...Buffer.from(value, 'utf8')];
    return [0x84, bytes.length, ...bytes];
}

function archive(text: string): Uint8Array {
    const words = [...Buffer.from(text, 'utf8')];
    return Uint8Array.from([
        0x04, 11, ...Buffer.from('streamtyped'), 0x81, 0xe8, 0x03,
        ...str('@'), 0x84, 0x84, ...str('NSMutableAttributedString'), 0x00,
        0x84, ...str('NSAttributedString'), 0x00, 0x84, ...str('NSObject'), 0x00, 0x85,
        // '@' again, by reference to string #0 (0x92 = -110, +110 = 0)
        0x92, 0x84, 0x84, ...str('NSMutableString'), 0x01, 0x84, ...str('NSString'), 0x01,
        // NSObject by reference to object #3 (0x95 = -107, +110 = 3)
        0x95,
        ...str('+'), words.length, ...words,
    ]);
}

test('attributedBody: reads the words, and returns null for junk', () => {
    assert.equal(attributedBodyText(archive('see you at 5 ✅')), 'see you at 5 ✅');
    assert.equal(attributedBodyText(Uint8Array.from([1, 2, 3])), null);
    assert.equal(attributedBodyText(null), null);
});

// ---- Mac watcher against a miniature chat.db ----

function miniChatDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, style INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER DEFAULT 0,
            item_type INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage', associated_message_type INTEGER DEFAULT 0,
            balloon_bundle_id TEXT, handle_id INTEGER, cache_roomnames TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    `);
    db.prepare('INSERT INTO handle VALUES (1, ?), (2, ?)').run(PERSON, OTHER);
    db.prepare('INSERT INTO chat VALUES (1, ?, 45), (2, ?, 43)').run(PERSON, 'chat123456');
    return db;
}

function addRow(db: DatabaseSync, row: { id: number; text?: string | null; body?: Uint8Array; fromMe?: number; handle?: number; chat?: number | null; itemType?: number; tapback?: number }) {
    db.prepare('INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, item_type, associated_message_type, handle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, `guid-${row.id}`, row.text ?? null, row.body ?? null, row.fromMe ?? 0, row.itemType ?? 0, row.tapback ?? 0, row.handle ?? 1);
    if (row.chat !== null) db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(row.chat ?? 1, row.id);
}

function watcherWith(db: DatabaseSync, results: ForwardResult[] = []) {
    const forwarded: InboundPayload[] = [];
    const state = { cursor: 0 };
    const watcher = createWatcher({ db, line: 'mac', state, save: () => {}, log: () => {}, forward: async (payload) => {
        const result = results.shift() ?? 'ok';
        if (result === 'ok') forwarded.push(payload);
        return result;
    } });
    return { watcher, forwarded, state };
}

test('mac watcher: first start skips history, then forwards only texts people sent', async () => {
    const db = miniChatDb();
    addRow(db, { id: 1, text: 'old history' });
    const { watcher, forwarded, state } = watcherWith(db);
    watcher.initialize();
    assert.equal(state.cursor, 1);
    addRow(db, { id: 2, text: 'hello there' });
    addRow(db, { id: 3, text: 'our reply', fromMe: 1 });
    addRow(db, { id: 4, text: 'Loved "hello"', tapback: 2000 });
    addRow(db, { id: 5, text: null, body: archive('text only in attributedBody') });
    addRow(db, { id: 6, text: 'group hi', handle: 2, chat: 2 });
    assert.equal(await watcher.scan(), 3);
    assert.deepEqual(forwarded.map((f) => [f.text, f.isGroup]), [['hello there', false], ['text only in attributedBody', false], ['group hi', true]]);
    assert.equal(state.cursor, 6);
});

test('mac watcher: a row with no chat yet waits; a down server keeps the cursor', async () => {
    const db = miniChatDb();
    const { watcher, forwarded, state } = watcherWith(db, ['retry']);
    addRow(db, { id: 1, text: 'settling', chat: null });
    assert.equal(await watcher.scan(), 0);
    assert.equal(state.cursor, 0);
    db.prepare('INSERT INTO chat_message_join VALUES (1, 1)').run();
    assert.equal(await watcher.scan(), 0); // server said retry
    assert.equal(state.cursor, 0);
    assert.equal(await watcher.scan(), 1);
    assert.equal(forwarded[0].text, 'settling');
    assert.equal(state.cursor, 1);
});

test('chat style 43 and chat ids mark group chats', () => {
    assert.ok(isGroupRow({ chatStyle: 43, chatId: 'x' }));
    assert.ok(isGroupRow({ chatStyle: null, chatId: 'chat99' }));
    assert.ok(!isGroupRow({ chatStyle: 45, chatId: PERSON }));
});

// ---- Mac sender ----

test('mac sender: argv only, leading dashes stripped for imsg, one send at a time', async () => {
    assert.equal(argvSafeText('--help me'), 'help me');
    assert.deepEqual(sendCommand({ via: 'imsg', imsgPath: 'imsg' }, PERSON, 'hi'), { command: 'imsg', args: ['send', '--to', PERSON, '--text', 'hi'] });
    const osa = sendCommand({ via: 'applescript', imsgPath: '' }, PERSON, '"; do shell script "x');
    assert.equal(osa.args.at(-1), '"; do shell script "x');
    let active = 0;
    let maxActive = 0;
    const send = createSender({ via: 'imsg', imsgPath: 'imsg', timeoutMs: 1000, run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { code: 0, stderr: '' };
    } });
    await Promise.all([send(PERSON, 'a'), send(PERSON, 'b'), send(PERSON, 'c')]);
    assert.equal(maxActive, 1);
    const failing = createSender({ via: 'imsg', imsgPath: 'imsg', timeoutMs: 1000, run: async () => ({ code: 1, stderr: 'not signed in' }) });
    await assert.rejects(failing(PERSON, 'x'), /not signed in/);
});

// ---- iPhone line inbound planning ----

test('phone inbound: floor, cursors, and what counts as a text', () => {
    const state = { ...emptyState(), floor: 100 };
    const rows = [
        { ROWID: 99, text: 'before the floor', is_from_me: 0, item_type: 0 },
        { ROWID: 102, text: 'second', is_from_me: 0, item_type: 0 },
        { ROWID: 101, text: 'first', is_from_me: 0, item_type: 0 },
        { ROWID: 103, text: 'ours', is_from_me: 1, item_type: 0 },
        { ROWID: 104, text: '', is_from_me: 0, item_type: 1 },
    ];
    const pending = pendingRows(state, PERSON, rows);
    assert.deepEqual(pending.map((r) => r.ROWID), [101, 102, 103, 104]);
    assert.deepEqual(pending.filter(isForwardable).map((r) => r.text), ['first', 'second']);
    for (const row of pending) settle(state, PERSON, row);
    assert.equal(state.cursors[PERSON], 104);
    assert.equal(pendingRows(state, PERSON, rows).length, 0);
});

test('phone inbound: only changed chats are read, except on the minute', () => {
    const state = { ...emptyState(), floor: 1, markers: { a: 'm1', b: 'm2' }, lastFullScan: 1_000_000 };
    const listed = [{ chat: 'a', marker: 'm1' }, { chat: 'b', marker: 'changed' }];
    assert.deepEqual(chatsToRead(state, listed, 1_000_500), ['b']);
    assert.deepEqual(chatsToRead(state, listed, 1_061_000), ['a', 'b']);
});

test('SMServer multipart body carries chat and text', () => {
    const { body, boundary } = multipartForm({ chat: PERSON, text: 'hi' });
    const text = body.toString('utf8');
    assert.ok(text.includes(`name="chat"\r\n\r\n${PERSON}\r\n`));
    assert.ok(text.endsWith(`--${boundary}--\r\n`));
});
