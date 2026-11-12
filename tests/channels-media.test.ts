import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createIMessageChannel, parseInboundIMessage } from '../src/channels/imessage.ts';
import { GROUP, PERSON, recordingChannel } from './helpers.ts';

test('inbound iMessage: groups carry their chat id, attachments are cleaned', () => {
    const group = parseInboundIMessage({ line: 'mac', from: PERSON, text: '', guid: 'g1', isGroup: true, chat: GROUP, service: 'iMessage', attachments: [
        { url: 'http://127.0.0.1:3101/a/1', mimeType: 'IMAGE/JPEG', fileName: 'IMG_1.jpeg' },
        { nope: true },
        'junk',
    ] });
    assert.deepEqual(group, { line: 'mac', from: PERSON, text: '', guid: 'g1', isGroup: true, chat: GROUP, service: 'iMessage', replyTo: undefined,
        attachments: [{ url: 'http://127.0.0.1:3101/a/1', mimeType: 'image/jpeg', fileName: 'IMG_1.jpeg' }] });
    // A "group" whose id is the sender, or that has no id, cannot be routed back to the group.
    assert.equal(parseInboundIMessage({ line: 'mac', from: PERSON, text: 'hi', guid: 'g2', isGroup: true, chat: PERSON })!.chat, undefined);
    assert.equal(parseInboundIMessage({ line: 'mac', from: PERSON, text: 'hi', guid: 'g3', isGroup: true })!.chat, undefined);
    assert.equal(parseInboundIMessage({ line: 'mac', from: PERSON, text: 'hi', guid: 'g4', chat: GROUP })!.chat, undefined);
});

test('iMessage channel: files, voice notes and typing use the bridge contract', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const channel = createIMessageChannel({ lines: { mac: 'http://127.0.0.1:3101' }, defaultLine: 'mac', bridgeKey: 'k', fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch });
    await channel.sendFiles!({ channel: 'imessage', handle: GROUP, line: 'mac' }, ['/srv/media/voice-1.m4a'], { audio: true });
    await channel.sendFiles!({ channel: 'imessage', handle: PERSON }, ['/srv/media/contact.vcf']);
    await channel.typing!({ channel: 'imessage', handle: PERSON });
    assert.deepEqual(calls, [
        { url: 'http://127.0.0.1:3101/send', body: { to: GROUP, files: ['/srv/media/voice-1.m4a'], audio: true } },
        { url: 'http://127.0.0.1:3101/send', body: { to: PERSON, files: ['/srv/media/contact.vcf'] } },
        { url: 'http://127.0.0.1:3101/typing', body: { to: PERSON } },
    ]);
});

test('router: files and typing obey the same rules as text', async () => {
    const store = openStore(':memory:');
    const imessage = recordingChannel();
    const email = recordingChannel('email', 'block');
    delete email.sendFiles;
    const router = createRouter(store, [imessage, email]);
    await assert.rejects(router.sendFile({ channel: 'imessage', handle: PERSON }, '/x.vcf', '[card]'), /never messaged us/);
    await router.typing({ channel: 'imessage', handle: PERSON });
    assert.equal(imessage.typed.length, 0);

    store.touchContact({ channel: 'imessage', handle: PERSON, line: 'phone1' });
    await router.sendFile({ channel: 'imessage', handle: PERSON }, '/x.vcf', '[card]');
    assert.equal(imessage.files[0].address.line, 'phone1');
    assert.equal(store.recentMessages('imessage', PERSON, 1)[0].text, '[card]');
    await router.typing({ channel: 'imessage', handle: PERSON });
    assert.equal(imessage.typed.length, 1);

    store.touchContact({ channel: 'email', handle: 'pat@example.com' });
    await assert.rejects(router.sendFile({ channel: 'email', handle: 'pat@example.com' }, '/x.vcf', '[card]'), /cannot send files/);

    store.touchContact({ channel: 'imessage', handle: GROUP, group: true });
    store.leaveGroup('imessage', GROUP, 'sms');
    await assert.rejects(router.send({ channel: 'imessage', handle: GROUP }, 'hi'), /left this group/);
    // Leaving only ever applies to a group.
    store.leaveGroup('imessage', PERSON, 'sms');
    assert.equal(store.getContact('imessage', PERSON)!.leftReason, null);
});

test('a database from before group chats gains the new columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    const path = join(dir, 'old.sqlite');
    try {
        const old = new DatabaseSync(path);
        old.exec(`CREATE TABLE contacts (channel TEXT NOT NULL, handle TEXT NOT NULL, line TEXT, thread TEXT, opted_out INTEGER NOT NULL DEFAULT 0,
            handoff_since TEXT, handoff_reason TEXT, operator_thread TEXT, first_seen TEXT NOT NULL, PRIMARY KEY (channel, handle));
            CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, handle TEXT NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
            INSERT INTO contacts (channel, handle, first_seen) VALUES ('imessage', '${PERSON}', '2030-01-01T00:00:00Z');`);
        old.close();
        const store = openStore(path);
        assert.equal(store.getContact('imessage', PERSON)!.isGroup, false);
        store.addMessage('imessage', GROUP, 'in', 'hi', { sender: PERSON, attachments: [{ url: 'http://127.0.0.1:3101/a', mimeType: 'image/png', fileName: 'a.png' }] });
        assert.equal(store.recentMessages('imessage', GROUP, 1)[0].sender, PERSON);
        assert.equal(store.recentMessages('imessage', GROUP, 1)[0].attachments.length, 1);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
