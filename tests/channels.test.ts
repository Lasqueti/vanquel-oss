import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter, splitBubbles } from '../src/channels/router.ts';
import { parseSlackEvent, slackSignature, verifySlackRequest } from '../src/channels/slack.ts';
import { parseTwilioInbound, twilioSignature, verifyTwilioSignature } from '../src/channels/sms-twilio.ts';
import { parsePostmarkInbound, replySubject, stripQuoted, createPostmarkChannel } from '../src/channels/email-postmark.ts';
import { createIMessageChannel, parseInboundIMessage } from '../src/channels/imessage.ts';
import { PERSON, recordingChannel } from './helpers.ts';

test('the router never starts a conversation with a stranger', async () => {
    const store = openStore(':memory:');
    const channel = recordingChannel();
    const router = createRouter(store, [channel]);
    await assert.rejects(router.send({ channel: 'imessage', handle: PERSON }, 'hi'), /never messaged us/);
    store.touchContact({ channel: 'imessage', handle: PERSON, line: 'phone1' });
    await router.send({ channel: 'imessage', handle: PERSON }, 'hi');
    assert.equal(channel.sent[0].address.line, 'phone1');
    store.setOptOut('imessage', PERSON, true);
    await assert.rejects(router.send({ channel: 'imessage', handle: PERSON }, 'hi'), /opted out/);
});

test('splitBubbles caps the number of bubbles', () => {
    assert.deepEqual(splitBubbles('a\n\nb\n\nc\n\nd\n\ne'), ['a', 'b', 'c', 'd\n\ne']);
});

test('Slack signatures: valid passes, tampered or stale fails', () => {
    const now = 1_900_000_000;
    const body = '{"type":"event_callback"}';
    const sig = slackSignature('secret', String(now), body);
    assert.ok(verifySlackRequest('secret', String(now), body, sig, now));
    assert.ok(!verifySlackRequest('secret', String(now), `${body} `, sig, now));
    assert.ok(!verifySlackRequest('secret', String(now), body, sig, now + 600));
});

test('Slack events: challenge, DM, operator thread reply, bot echo', () => {
    assert.deepEqual(parseSlackEvent({ type: 'url_verification', challenge: 'abc' }, 'COPS'), { kind: 'challenge', challenge: 'abc' });
    const dm = parseSlackEvent({ type: 'event_callback', event_id: 'E1', event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: ' hi ', ts: '1.0' } }, 'COPS');
    assert.deepEqual(dm, { kind: 'dm', eventId: 'E1', channel: 'D1', user: 'U1', text: 'hi' });
    const reply = parseSlackEvent({ type: 'event_callback', event_id: 'E2', event: { type: 'message', channel: 'COPS', user: 'U2', text: 'on it', ts: '2.0', thread_ts: '1.5' } }, 'COPS');
    assert.equal(reply.kind, 'thread-reply');
    assert.equal(parseSlackEvent({ type: 'event_callback', event: { type: 'message', channel: 'D1', channel_type: 'im', bot_id: 'B1', text: 'echo', ts: '3' } }, 'COPS').kind, 'ignore');
});

test('Twilio signatures and inbound parsing', () => {
    const params = { From: PERSON, To: '+15550100100', Body: 'hello', MessageSid: 'SM1' };
    const url = 'https://agent.example.com/channels/sms/twilio';
    const sig = twilioSignature('token', url, params);
    assert.ok(verifyTwilioSignature('token', url, params, sig));
    assert.ok(!verifyTwilioSignature('token', url, { ...params, Body: 'changed' }, sig));
    assert.ok(!verifyTwilioSignature('token', url, params, ''));
    assert.deepEqual(parseTwilioInbound(params), { from: PERSON, text: 'hello', id: 'SM1' });
});

test('Postmark inbound: sender, stripped reply, thread', () => {
    const mail = parsePostmarkInbound({
        FromFull: { Email: 'Pat@Example.com' },
        Subject: 'Booking',
        TextBody: 'Can I come Friday?\n\nOn Mon, Jan 1, Shop <help@example.com> wrote:\n> old stuff',
        MessageID: 'pm-1',
        Headers: [{ Name: 'Message-ID', Value: '<abc@example.com>' }],
    });
    assert.deepEqual(mail, { from: 'pat@example.com', text: 'Can I come Friday?', id: '<abc@example.com>', thread: { subject: 'Booking', messageId: '<abc@example.com>' } });
    assert.equal(stripQuoted('hi\n> quoted'), 'hi');
    assert.equal(replySubject('Re: x'), 'Re: x');
    assert.equal(replySubject('x'), 'Re: x');
});

test('Postmark outbound threads the reply', async () => {
    let sent: Record<string, unknown> = {};
    const channel = createPostmarkChannel({ serverToken: 't', fromAddress: 'help@example.com', fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}', { status: 200 });
    }) as typeof fetch });
    await channel.send({ channel: 'email', handle: 'pat@example.com', thread: JSON.stringify({ subject: 'Booking', messageId: '<abc@example.com>' }) }, 'Friday works.');
    assert.equal(sent.Subject, 'Re: Booking');
    assert.deepEqual(sent.Headers, [{ Name: 'In-Reply-To', Value: '<abc@example.com>' }, { Name: 'References', Value: '<abc@example.com>' }]);
});

test('iMessage channel picks the line bridge and falls back to the default line', async () => {
    const urls: string[] = [];
    const channel = createIMessageChannel({ lines: { mac: 'http://127.0.0.1:3101', phone1: 'http://127.0.0.1:3201' }, defaultLine: 'mac', bridgeKey: 'k', fetchImpl: (async (url: string) => {
        urls.push(url);
        return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch });
    await channel.send({ channel: 'imessage', handle: PERSON, line: 'phone1' }, 'a');
    await channel.send({ channel: 'imessage', handle: PERSON, line: 'gone' }, 'b');
    assert.deepEqual(urls, ['http://127.0.0.1:3201/send', 'http://127.0.0.1:3101/send']);
    assert.equal(parseInboundIMessage({ line: 'mac', from: PERSON, text: 'x' }), null);
});
