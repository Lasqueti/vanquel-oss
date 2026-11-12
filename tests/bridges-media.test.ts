// tests/bridges-media.test.ts
// Media on the iMessage bridges, with fakes only (no network, no phone): the
// tweak client's parsing and staging, the /attachment path checks, group and
// attachment rows in the Mac watcher, the phone's inbound rules, the
// websocket frame for typing, and the Mac sender's commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentKey, attachmentUrl, localAttachmentHandler, pathInside } from '../bridges/attachments.ts';
import type { FileReply } from '../bridges/attachments.ts';
import type { InboundPayload } from '../bridges/forward.ts';
import { parseSendRequest, parseTapbackRequest } from '../bridges/outbound.ts';
import { ATTACHMENT_WAIT_MS, createWatcher } from '../bridges/mac/watcher.ts';
import { NotSupported, chatGuidFor, sendCommands, tapbackCommand } from '../bridges/mac/sender.ts';
import { isForwardable, isPhoneAttachmentPath, rowAttachments, senderOf } from '../bridges/phone/inbound.ts';
import { maxOutboundAttachments, multipartForm } from '../bridges/phone/smserver.ts';
import { createTweakClient, parseMessageStatus, parseReply, toGameRow } from '../bridges/phone/tweak.ts';
import type { PhoneShell } from '../bridges/phone/ssh.ts';
import { upgradeRequest, websocketSend, websocketTextFrame } from '../bridges/phone/websocket.ts';
import type { Pipe } from '../bridges/phone/websocket.ts';
import { OTHER, PERSON } from './helpers.ts';

const KEY = 'test-bridge-key';
const noSleep = async () => {};

// ---- tweak client ----

type Call = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams };

function fakeTweak(answers: Array<[number, string]>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body ?? '')) });
        const [status, body] = answers.shift() ?? [500, 'no more answers'];
        return new Response(body, { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
}

test('tweak replies: OK carries a guid, ERR and non-2xx throw', () => {
    assert.deepEqual(parseReply('/poc/send-photo', 200, 'OK sent guid=ABC-1 files=2 transferGuid=x\n'), { guid: 'ABC-1', raw: 'OK sent guid=ABC-1 files=2 transferGuid=x' });
    assert.equal(parseReply('/poc/send-balloon', 200, 'OK sent balloon guid= bundle=b image=none').guid, null);
    assert.throws(() => parseReply('/poc/send-card', 200, 'ERR chat not found: x'), /refused: ERR chat not found/);
    assert.throws(() => parseReply('/poc/send-card', 403, 'forbidden'), /answered 403/);
    assert.deepEqual(parseMessageStatus('OK found=1 rowid=812 sent=1 delivered=0 error=0 attachments=3'), { found: true, rowId: 812, sent: true, delivered: false, error: 0, attachments: 3 });
    assert.equal(parseMessageStatus('OK found=0')?.found, false);
    assert.equal(parseMessageStatus('ERR sqlite open rc=14'), null);
});

test('tweak sendPhoto: one message, the secret header, then proof every file landed', async () => {
    const { calls, fetchImpl } = fakeTweak([[200, 'OK sent guid=G1 files=2 transferGuid=t'], [200, 'OK found=1 rowid=9 sent=1 delivered=0 error=0 attachments=2']]);
    const client = createTweakClient({ url: 'http://phone.test:8799/', secret: 's3cret', fetchImpl, sleep: noSleep });
    const result = await client.sendPhoto(PERSON, ['/var/mobile/a.jpg', '/var/mobile/b.jpg']);
    assert.deepEqual(result, { guid: 'G1', raw: 'OK sent guid=G1 files=2 transferGuid=t', verified: true });
    assert.equal(calls[0].url, 'http://phone.test:8799/poc/send-photo');
    assert.equal(calls[0].headers['X-Tweak-Secret'], 's3cret');
    assert.equal(calls[0].body.get('to'), PERSON);
    assert.equal(calls[0].body.get('filePaths'), '/var/mobile/a.jpg|/var/mobile/b.jpg');
    assert.equal(calls[1].url, 'http://phone.test:8799/poc/message-status?guid=G1');

    const partial = fakeTweak([[200, 'OK sent guid=G2 files=3'], ...Array.from({ length: 15 }, (): [number, string] => [200, 'OK found=1 rowid=10 sent=1 delivered=0 error=0 attachments=1'])]);
    const client2 = createTweakClient({ url: 'http://phone.test:8799', secret: 's', fetchImpl: partial.fetchImpl, sleep: noSleep });
    await assert.rejects(client2.sendPhoto(PERSON, ['/a', '/b', '/c']), /only 1 of 3 file/);
});

test('tweak sendPhoto: a voice note is one file with audio=1, caption first as text', async () => {
    const { calls, fetchImpl } = fakeTweak([[200, 'OK sent guid=T1'], [200, 'OK sent guid=V1 files=1'], [200, 'OK found=1 rowid=3 sent=1 delivered=1 error=0 attachments=1']]);
    const client = createTweakClient({ url: 'http://phone.test:8799', secret: 's', fetchImpl, sleep: noSleep });
    await client.sendPhoto(PERSON, ['/var/mobile/v.m4a'], { audio: true, text: 'listen' });
    assert.equal(calls[0].url.endsWith('/poc/send-text'), true);
    assert.equal(calls[0].body.get('text'), 'listen');
    assert.equal(calls[1].body.get('audio'), '1');
    assert.equal(calls[1].body.get('filePath'), '/var/mobile/v.m4a');
    await assert.rejects(client.sendPhoto(PERSON, ['/a', '/b'], { audio: true }), /exactly one file/);
});

test('tweak: local files are staged on the phone at 0644 and removed after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vq-test-'));
    try {
        const local = join(dir, 'pic.jpg');
        writeFileSync(local, 'jpeg');
        const copied: string[] = [];
        const ran: string[] = [];
        const shell: PhoneShell = {
            copyTo: async (_from, to) => {
                copied.push(to);
                return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
            },
            copyFrom: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }),
            exec: async (command) => {
                ran.push(command);
                return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
            },
        };
        const { calls, fetchImpl } = fakeTweak([[200, 'OK sent balloon guid=B1 bundle=x image=inline']]);
        const client = createTweakClient({ url: 'http://phone.test:8799', secret: 's', fetchImpl, shell, stageDir: '/var/mobile/stage', sleep: noSleep });
        const result = await client.sendCard({ to: PERSON, bundleId: 'com.example.card', payloadBase64: 'AAAA', imageFile: local });
        assert.equal(result.guid, 'B1');
        assert.equal(copied.length, 1);
        assert.match(copied[0], /^\/var\/mobile\/stage\/vq-card-\d+_[0-9a-f]{8}-0\.jpg$/);
        assert.equal(calls[0].body.get('imageFile'), copied[0]);
        assert.deepEqual(ran, [`rm -f ${copied[0]}`]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('tweak: balloons go to the MobileSMS listener when one is set', async () => {
    const { calls, fetchImpl } = fakeTweak([[200, 'pong host=MobileSMS im:not-loaded'], [200, 'OK sent balloon guid=M1 bundle=b image=none']]);
    const client = createTweakClient({ url: 'http://phone.test:8799', gameUrl: 'http://phone.test:8800', secret: 's', fetchImpl, sleep: noSleep });
    const result = await client.sendBalloon({ to: PERSON, bundleId: 'com.example.game', payloadBase64: 'AAAA', replyToGuid: 'R1' });
    assert.equal(result.guid, 'M1');
    assert.equal(calls[0].url, 'http://phone.test:8800/poc/ping');
    assert.equal(calls[1].url, 'http://phone.test:8800/poc/send-balloon');
    assert.equal(calls[1].body.get('replyToGuid'), 'R1');
});

test('tweak: tapbacks retry only the lookup misses; readGames maps rows and keeps extras', async () => {
    const { calls, fetchImpl } = fakeTweak([[200, 'ERR message item not loaded'], [200, 'OK sent tapback']]);
    const client = createTweakClient({ url: 'http://phone.test:8799', secret: 's', fetchImpl, sleep: noSleep });
    assert.equal(await client.sendTapback({ to: PERSON, guid: 'G', type: 'love' }), 'OK sent tapback');
    assert.equal(calls.length, 2);
    const refused = fakeTweak([[200, 'ERR unsupported tapback type']]);
    await assert.rejects(createTweakClient({ url: 'http://p', secret: 's', fetchImpl: refused.fetchImpl, sleep: noSleep }).sendTapback({ to: PERSON, guid: 'G', type: 'x' }), /unsupported/);
    assert.equal(refused.calls.length, 1);

    const rows = [{ rowid: 41, guid: 'g41', chatGuid: `iMessage;-;${PERSON}`, bundleId: 'com.example.gp', payloadB64: 'QUJD', extra: 1 }];
    const games = fakeTweak([[200, JSON.stringify(rows)], [200, 'ERR sms.db not readable here and no helper at /x']]);
    const reader = createTweakClient({ url: 'http://p', secret: 's', fetchImpl: games.fetchImpl });
    const [row] = await reader.readGames(40, 25);
    assert.deepEqual(row, { ...rows[0], rowId: 41, guid: 'g41', chat: `iMessage;-;${PERSON}`, isFromMe: false, payloadBase64: 'QUJD', balloonBundleId: 'com.example.gp' });
    assert.equal(games.calls[0].url, 'http://p/poc/read-games?afterRowid=40&limit=25');
    await assert.rejects(reader.readGames(0, 25), /sms\.db not readable/);
    assert.equal(toGameRow({ rowId: 7 }).rowId, 7);
});

// ---- /attachment ----

async function fetchFile(handler: ReturnType<typeof localAttachmentHandler>, path: string, key = attachmentKey(KEY, path)): Promise<FileReply> {
    return handler(new URLSearchParams({ path, key }), {});
}

test('/attachment on the Mac: only files under the attachments root, only with the right key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vq-att-'));
    try {
        const root = join(dir, 'Attachments');
        mkdirSync(join(root, 'ab'), { recursive: true });
        writeFileSync(join(root, 'ab', 'IMG_1.jpeg'), 'photo');
        writeFileSync(join(dir, 'chat.db'), 'secret');
        const handler = localAttachmentHandler(root, KEY);
        const ok = await fetchFile(handler, join(root, 'ab', 'IMG_1.jpeg'));
        assert.equal(ok.status, 200);
        assert.ok('stream' in ok && ok.contentType === 'image/jpeg');
        if ('stream' in ok) assert.equal(Buffer.concat(await ok.stream.toArray()).toString('utf8'), 'photo');
        assert.equal((await fetchFile(handler, join(root, 'ab', '..', '..', 'chat.db'))).status, 403);
        assert.equal((await fetchFile(handler, join(dir, 'chat.db'))).status, 403);
        assert.equal((await fetchFile(handler, join(root, 'missing.jpg'))).status, 403);
        assert.equal((await fetchFile(handler, join(root, 'ab', 'IMG_1.jpeg'), 'wrong')).status, 401);
        assert.equal((await handler(new URLSearchParams({ path: join(dir, 'chat.db') }), { 'x-bridge-key': KEY })).status, 403);
        try {
            symlinkSync(join(dir, 'chat.db'), join(root, 'link.jpg'));
            assert.equal(pathInside(root, join(root, 'link.jpg')), null);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; // Windows without symlink rights
        }
        assert.match(attachmentUrl('http://127.0.0.1:3101', KEY, '/x/a b.jpg'), /^http:\/\/127\.0\.0\.1:3101\/attachment\?path=%2Fx%2Fa\+b\.jpg&key=[0-9a-f]{32}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('/attachment on a phone line: only relative Attachments/ paths', () => {
    assert.ok(isPhoneAttachmentPath('Attachments/64/04/ABC/IMG_0002.PNG'));
    assert.ok(!isPhoneAttachmentPath('Attachments/../sms.db'));
    assert.ok(!isPhoneAttachmentPath('/var/mobile/Library/SMS/sms.db'));
    assert.ok(!isPhoneAttachmentPath('../Attachments/x'));
    assert.ok(!isPhoneAttachmentPath('Attachments\\..\\sms.db'));
});

// ---- Mac watcher: groups, replies, attachments ----

function chatDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, style INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER DEFAULT 0,
            item_type INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage', associated_message_type INTEGER DEFAULT 0,
            balloon_bundle_id TEXT, handle_id INTEGER, cache_roomnames TEXT, cache_has_attachments INTEGER DEFAULT 0,
            is_audio_message INTEGER DEFAULT 0, thread_originator_guid TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, transfer_name TEXT, mime_type TEXT, transfer_state INTEGER);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle VALUES (1, ?), (2, ?)').run(PERSON, OTHER);
    db.prepare('INSERT INTO chat VALUES (1, ?, 45), (2, ?, 43)').run(PERSON, 'chat123456');
    return db;
}

function add(db: DatabaseSync, row: { id: number; text?: string | null; handle?: number; chat?: number; fromMe?: number; files?: number; audio?: number; replyTo?: string }) {
    db.prepare('INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, cache_has_attachments, is_audio_message, thread_originator_guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, `guid-${row.id}`, row.text ?? null, row.fromMe ?? 0, row.handle ?? 1, row.files ? 1 : 0, row.audio ?? 0, row.replyTo ?? null);
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(row.chat ?? 1, row.id);
}

function attach(db: DatabaseSync, messageId: number, id: number, filename: string, state = 5, mime = 'image/jpeg') {
    db.prepare('INSERT INTO attachment VALUES (?, ?, ?, ?, ?)').run(id, filename, filename.split('/').pop() ?? filename, mime, state);
    db.prepare('INSERT INTO message_attachment_join VALUES (?, ?)').run(messageId, id);
}

function watch(db: DatabaseSync, clock = { t: 0 }) {
    const forwarded: InboundPayload[] = [];
    const state = { cursor: 0 };
    const watcher = createWatcher({
        db, line: 'mac', state, save: () => {}, log: () => {},
        forward: async (payload) => {
            forwarded.push(payload);
            return 'ok';
        },
        attachmentUrl: (path) => `http://bridge.test/attachment?path=${encodeURIComponent(path)}`,
        fileExists: () => true,
        now: () => clock.t,
    });
    return { watcher, forwarded, state };
}

test('mac watcher: a group message comes from its sender, with the chat id and the reply it answers', async () => {
    const db = chatDb();
    add(db, { id: 1, text: 'our question', fromMe: 1, chat: 2 });
    add(db, { id: 2, text: 'yes please', handle: 2, chat: 2, replyTo: 'p:0/guid-1' });
    const { watcher, forwarded } = watch(db);
    assert.equal(await watcher.scan(), 1);
    assert.equal(forwarded[0].from, OTHER);
    assert.equal(forwarded[0].chat, 'chat123456');
    assert.equal(forwarded[0].isGroup, true);
    assert.deepEqual(forwarded[0].replyTo, { guid: 'guid-1', text: 'our question', isFromMe: true });
});

test('mac watcher: an attachment-only message is forwarded, after its file has arrived', async () => {
    const db = chatDb();
    const clock = { t: 1_000 };
    add(db, { id: 1, text: '\uFFFC', files: 1 });
    attach(db, 1, 1, '~/Library/Messages/Attachments/ab/IMG_1.HEIC', 0, 'image/heic');
    add(db, { id: 2, text: 'did you get it' });
    const { watcher, forwarded, state } = watch(db, clock);
    assert.equal(await watcher.scan(), 0, 'still downloading: holds the cursor');
    assert.equal(state.cursor, 0);
    db.prepare('UPDATE attachment SET transfer_state = 5').run();
    assert.equal(await watcher.scan(), 2);
    assert.equal(forwarded[0].text, '');
    assert.equal(forwarded[0].attachments?.length, 1);
    assert.equal(forwarded[0].attachments?.[0].mimeType, 'image/heic');
    assert.equal(forwarded[0].attachments?.[0].fileName, 'IMG_1.HEIC');
    assert.match(forwarded[0].attachments?.[0].url ?? '', /^http:\/\/bridge\.test\/attachment\?path=.*IMG_1\.HEIC$/);
    assert.equal(forwarded[1].text, 'did you get it');
    assert.equal(forwarded[1].attachments, undefined);
});

test('mac watcher: a file that never arrives stops holding the line after the wait', async () => {
    const db = chatDb();
    const clock = { t: 0 };
    add(db, { id: 1, text: 'look', files: 1 });
    attach(db, 1, 1, '/tmp/never.jpg', 0);
    const { watcher, forwarded } = watch(db, clock);
    assert.equal(await watcher.scan(), 0);
    clock.t = ATTACHMENT_WAIT_MS + 1;
    assert.equal(await watcher.scan(), 1);
    assert.equal(forwarded[0].text, 'look');
    assert.equal(forwarded[0].attachments, undefined);
});

// ---- phone inbound and sends ----

test('phone inbound: attachment-only rows count, group rows name their sender', () => {
    const photo = { ROWID: 5, text: '\uFFFC', is_from_me: 0, item_type: 0, attachments: [{ filename: 'Attachments/aa/IMG_1.JPG', mime_type: 'image/jpeg' }] };
    assert.ok(isForwardable(photo));
    assert.deepEqual(rowAttachments(photo), [{ path: 'Attachments/aa/IMG_1.JPG', mimeType: 'image/jpeg' }]);
    assert.ok(!isForwardable({ ROWID: 6, text: '\uFFFC', is_from_me: 0, item_type: 0 }));
    assert.equal(senderOf('chat987654', { id: OTHER }), OTHER);
    assert.equal(senderOf(PERSON, { id: '' }), PERSON);
});

test('SMServer: files repeat the attachments field; the max per message proves a bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vq-mp-'));
    try {
        const file = join(dir, 'a.png');
        writeFileSync(file, 'PNGDATA');
        const { body } = multipartForm({ chat: PERSON, text: '' }, { attachments: [file, file] });
        const text = body.toString('latin1');
        assert.equal(text.split('name="attachments"; filename="a.png"\r\nContent-Type: image/png').length - 1, 2);
        assert.ok(text.includes('PNGDATA'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    const rows = [
        { ROWID: 10, is_from_me: 1, attachments: [{}, {}] },
        { ROWID: 12, is_from_me: 1, attachments: [{}, {}, {}] },
        { ROWID: 13, is_from_me: 0, attachments: [{}, {}, {}, {}] },
    ];
    assert.equal(maxOutboundAttachments(rows, 10), 3);
    assert.equal(maxOutboundAttachments(rows, 12), 0);
});

// ---- typing websocket ----

test('websocket: a masked text frame that unmasks to the payload', () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const frame = websocketTextFrame(`typing:${PERSON}`, mask);
    assert.equal(frame[0], 0x81);
    assert.equal(frame[1], 0x80 | Buffer.byteLength(`typing:${PERSON}`));
    assert.deepEqual(frame.subarray(2, 6), mask);
    const unmasked = Buffer.from(frame.subarray(6).map((byte, i) => byte ^ mask[i % 4]));
    assert.equal(unmasked.toString('utf8'), `typing:${PERSON}`);
    const long = websocketTextFrame('x'.repeat(300), mask);
    assert.equal(long[1], 0x80 | 126);
    assert.equal(long.readUInt16BE(2), 300);
    assert.equal(long.length, 4 + 4 + 300);
    assert.equal(websocketTextFrame('y'.repeat(70_000), mask)[1], 0x80 | 127);
    const upgrade = upgradeRequest(new URL('ws://phone.test:8740'), 'a2V5').toString('ascii');
    assert.ok(upgrade.startsWith('GET / HTTP/1.1\r\nHost: phone.test:8740\r\nUpgrade: websocket\r\n'));
    assert.ok(upgrade.endsWith('\r\n\r\n'));
});

function fakePipe(answer: string | null) {
    const written: Buffer[] = [];
    let onData: (chunk: Buffer) => void = () => {};
    let ended = false;
    const pipe: Pipe = {
        write: (bytes) => {
            written.push(bytes);
            if (written.length === 1 && answer !== null) setTimeout(() => onData(Buffer.from(answer, 'latin1')), 5);
        },
        onData: (listener) => {
            onData = listener;
        },
        onClose: () => {},
        end: () => {
            ended = true;
        },
    };
    return { pipe, written, ended: () => ended };
}

test('websocket: handshake, then one frame after the 101; no answer at all throws', async () => {
    const ok = fakePipe('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
    assert.deepEqual(await websocketSend('ws://phone.test:8740', `idle:${PERSON}`, { open: () => ok.pipe, graceMs: 0 }), { upgraded: true });
    assert.equal(ok.written.length, 2);
    assert.equal(ok.written[1][0], 0x81);
    assert.ok(ok.ended());
    const refused = fakePipe('HTTP/1.1 400 Bad Request\r\n\r\n');
    assert.deepEqual(await websocketSend('ws://phone.test:8740', 'typing:x', { open: () => refused.pipe, graceMs: 0 }), { upgraded: false });
    assert.equal(refused.written.length, 1);
    const silent = fakePipe(null);
    await assert.rejects(websocketSend('ws://phone.test:8740', 'typing:x', { open: () => silent.pipe, graceMs: 0 }), /no websocket answer/);
    await assert.rejects(websocketSend('wss://phone.test:8740', 'typing:x', { open: () => silent.pipe }), /only ws:/);
});

// ---- Mac sender and request bodies ----

test('mac sender: text then one send per file; voice notes and tapbacks need imsg', () => {
    const imsg = { via: 'imsg' as const, imsgPath: 'imsg' };
    assert.deepEqual(sendCommands(imsg, PERSON, 'two pics', { files: ['/p/a.jpg', '/p/b.jpg'] }).map((c) => c.args), [
        ['send', '--to', PERSON, '--text', 'two pics'],
        ['send', '--to', PERSON, '--file', '/p/a.jpg'],
        ['send', '--to', PERSON, '--file', '/p/b.jpg'],
    ]);
    assert.deepEqual(sendCommands(imsg, PERSON, '', { files: ['/p/v.m4a'], audio: true })[0].args, ['send-attachment', '--chat', `iMessage;-;${PERSON}`, '--file', '/p/v.m4a', '--audio']);
    const osa = { via: 'applescript' as const, imsgPath: '' };
    assert.equal(sendCommands(osa, PERSON, '', { files: ['/p/a.jpg'] })[0].args.at(-1), '/p/a.jpg');
    assert.throws(() => sendCommands(osa, PERSON, '', { files: ['/p/v.m4a'], audio: true }), NotSupported);
    assert.throws(() => tapbackCommand(osa, PERSON, 'g', 'love'), NotSupported);
    assert.deepEqual(tapbackCommand(imsg, 'chat123', 'g', 'laugh').args, ['tapback', '--chat', 'iMessage;+;chat123', '--message', 'g', '--kind', 'laugh', '--json']);
    assert.equal(chatGuidFor(`SMS;-;${PERSON}`), `SMS;-;${PERSON}`);
});

test('send bodies: files must be real absolute paths; audio is one file; tapback kinds are checked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vq-req-'));
    try {
        const file = join(dir, 'v.m4a');
        writeFileSync(file, 'm4a');
        assert.deepEqual(parseSendRequest({ to: PERSON, files: [file], audio: true }), { to: PERSON, text: '', files: [file], audio: true });
        assert.throws(() => parseSendRequest({ to: PERSON }), /text or files/);
        assert.throws(() => parseSendRequest({ to: PERSON, files: ['relative.jpg'] }), /absolute/);
        assert.throws(() => parseSendRequest({ to: PERSON, files: [join(dir, 'missing.jpg')] }), /absolute/);
        assert.throws(() => parseSendRequest({ to: PERSON, files: [file, file], audio: true }), /exactly one/);
        assert.throws(() => parseSendRequest({ to: PERSON, files: 'x' }), /array/);
        assert.deepEqual(parseTapbackRequest({ to: PERSON, guid: 'g', kind: 'Love' }), { to: PERSON, guid: 'g', kind: 'love' });
        assert.throws(() => parseTapbackRequest({ to: PERSON, guid: 'g', kind: 'heart-eyes' }), /kind must be/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
