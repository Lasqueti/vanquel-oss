import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createPipeline } from '../src/agent/pipeline.ts';
import type { PipelineConfig, PipelineDeps } from '../src/agent/pipeline.ts';
import { buildTools } from '../src/agent/tools.ts';
import type { ChatMessage, ContentPart, Llm } from '../src/agent/llm.ts';
import type { Attachment, InboundMessage } from '../src/channels/types.ts';
import { createImageLoader } from '../src/agent/media.ts';
import { PERSON, callTool, quietLog, recordingChannel, say, scriptedLlm, textOf } from './helpers.ts';

const config: PipelineConfig = { agentName: 'Sam', businessName: 'Test Co', businessInfo: '', timeZone: 'UTC', historyLimit: 30, maxRepliesPerHour: 30, debounceMs: 0, maxToolRounds: 5 };
const PHOTO: Attachment = { url: 'http://127.0.0.1:3101/attachments/1', mimeType: 'image/jpeg', fileName: 'IMG_0001.jpeg' };
const PDF: Attachment = { url: 'http://127.0.0.1:3101/attachments/2', mimeType: 'application/pdf', fileName: 'menu.pdf' };

function setup(llm: Llm, extra: Partial<PipelineDeps> = {}, overrides: Partial<PipelineConfig> = {}) {
    const store = openStore(':memory:');
    const channel = recordingChannel();
    const router = createRouter(store, [channel]);
    const pipeline = createPipeline({
        store, router, llm, tools: buildTools({ browse: false, voice: Boolean(extra.voiceNotes) }), log: quietLog,
        operator: { notifyHandoff: async () => {}, forward: async () => {} },
        config: { ...config, ...overrides }, ...extra,
    });
    const inbound = (text: string, more: Partial<InboundMessage> = {}) => pipeline.handleInbound({ address: { channel: 'imessage', handle: PERSON, line: 'mac' }, text, ...more });
    return { store, channel, pipeline, inbound };
}

const userTurns = (messages: ChatMessage[]) => messages.filter((m) => m.role === 'user');

test('a tapback is stored as context and never answered', async () => {
    const llm = scriptedLlm([say('See you at 3.'), say('Anything else?')]);
    const t = setup(llm);
    await t.inbound('book me for 3');
    await t.pipeline.idle();
    assert.equal(await t.inbound('Loved \u201CSee you at 3.\u201D'), 'reaction');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.length, 1);
    await t.inbound('also, do you take cards?');
    await t.pipeline.idle();
    const turns = userTurns(llm.calls[1]).map((m) => textOf(m.content));
    assert.deepEqual(turns.slice(-2), ['(tapback) Loved \u201CSee you at 3.\u201D', 'also, do you take cards?']);
});

test('without vision, a photo is a note; a photo alone is still a message', async () => {
    const llm = scriptedLlm([say('Nice photo!')]);
    const t = setup(llm);
    assert.equal(await t.inbound('', { attachments: [PHOTO, PDF] }), 'scheduled');
    await t.pipeline.idle();
    assert.deepEqual(userTurns(llm.calls[0]).map((m) => m.content), ['[photo]\n[file: menu.pdf: cannot be opened here]']);
    assert.equal(await t.inbound(''), 'empty');
});

test('with vision, unanswered photos reach the model as images; answered ones stay notes', async () => {
    const loaded: string[] = [];
    const llm = scriptedLlm([say('A cat.'), say('Also a cat.')]);
    const t = setup(llm, { loadImage: async (a) => { loaded.push(a.url); return a.url.endsWith('/bad') ? null : 'data:image/jpeg;base64,AAAA'; } });
    await t.inbound('what is this', { attachments: [PHOTO] });
    await t.pipeline.idle();
    const first = userTurns(llm.calls[0])[0].content as ContentPart[];
    assert.deepEqual(first, [{ type: 'text', text: 'what is this\n[photo]' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }]);

    await t.inbound('and this', { attachments: [{ ...PHOTO, url: 'http://127.0.0.1:3101/bad' }] });
    await t.pipeline.idle();
    const [older, newer] = userTurns(llm.calls[1]);
    assert.equal(older.content, 'what is this\n[photo]');
    assert.equal(newer.content, 'and this\n[photo: could not be opened]');
    assert.equal(loaded.length, 2);
});

test('the typing bubble shows before the model is asked', async () => {
    const order: string[] = [];
    const t = setup({ chat: async () => { order.push('model'); return say('hi'); } });
    const typing = t.channel.typing!;
    t.channel.typing = async (address) => { order.push('typing'); await typing(address); };
    await t.inbound('hello');
    await t.pipeline.idle();
    assert.deepEqual(order, ['typing', 'model']);
});

test('a failing typing call never costs the reply', async () => {
    const t = setup(scriptedLlm([say('still here')]));
    t.channel.typing = async () => { throw new Error('bridge down'); };
    await t.inbound('hello');
    await t.pipeline.idle();
    assert.equal(t.channel.sent[0].text, 'still here');
});

test('a voice note goes out as audio when asked for, and falls back to text', async () => {
    const spoken: string[] = [];
    const voiceNotes = { synthesize: async (text: string) => { spoken.push(text); return '/tmp/voice-1.m4a'; } };
    const t = setup(scriptedLlm([callTool('reply_with_voice_note', {}), say('Sure, see you Friday.')]), { voiceNotes });
    await t.inbound('send me a voice message');
    await t.pipeline.idle();
    assert.deepEqual(t.channel.files, [{ address: { channel: 'imessage', handle: PERSON, line: 'mac', thread: undefined }, files: ['/tmp/voice-1.m4a'], audio: true }]);
    assert.equal(t.channel.sent.length, 0);
    assert.equal(t.store.recentMessages('imessage', PERSON, 5).at(-1)!.text, '[voice note] Sure, see you Friday.');

    const broken = setup(scriptedLlm([callTool('reply_with_voice_note', {}), say('Sure.')]), { voiceNotes: { synthesize: async () => { throw new Error('no afconvert'); } } });
    await broken.inbound('voice please');
    await broken.pipeline.idle();
    assert.deepEqual(broken.channel.sent.map((s) => s.text), ['Sure.']);

    // A link is better read than heard.
    const linky = setup(scriptedLlm([callTool('reply_with_voice_note', {}), say('Book at https://example.com/book')]), { voiceNotes });
    await linky.inbound('voice please');
    await linky.pipeline.idle();
    assert.equal(linky.channel.files.length, 0);
    assert.equal(linky.channel.sent.length, 1);
    assert.equal(spoken.length, 1);
});

test('the contact card follows the first reply to a new person, once', async () => {
    const t = setup(scriptedLlm([say('Hi!'), say('Again!')]), {}, { contactCardPath: '/srv/media/contact.vcf' });
    await t.inbound('hello');
    await t.pipeline.idle();
    await t.inbound('hello again');
    await t.pipeline.idle();
    assert.deepEqual(t.channel.files.map((f) => f.files), [['/srv/media/contact.vcf']]);
    assert.deepEqual(t.channel.sent.map((s) => s.text), ['Hi!', 'Again!']);

    const group = setup(scriptedLlm([say('Hi all')]), {}, { contactCardPath: '/srv/media/contact.vcf' });
    await group.pipeline.handleInbound({ address: { channel: 'imessage', handle: 'chat-room-1', line: 'mac', group: true }, sender: PERSON, text: 'sam hi' });
    await group.pipeline.idle();
    assert.equal(group.channel.files.length, 0);
    assert.equal(group.channel.sent.length, 1);
});

test('the image loader only fetches from bridges, caps size and converts HEIC', async () => {
    const fetched: Array<{ url: string; key: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        fetched.push({ url, key: (init.headers as Record<string, string>)['X-Bridge-Key'] });
        if (url.endsWith('/big')) return new Response(new Uint8Array(20), { headers: { 'content-type': 'image/png' } });
        if (url.endsWith('/heic')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/heic' } });
        return new Response(new Uint8Array([255, 216]), { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const load = createImageLoader({ bridgeUrls: ['http://127.0.0.1:3101'], bridgeKey: 'k', maxBytes: 10, fetchImpl, convertHeic: async () => Buffer.from([9]) });
    assert.equal(await load({ ...PHOTO, url: 'http://127.0.0.1:3101/a' }), 'data:image/jpeg;base64,/9g=');
    assert.equal(await load({ ...PHOTO, url: 'http://203.0.113.5:3101/a' }), null);
    assert.equal(await load({ ...PHOTO, url: 'http://127.0.0.1:3101/big' }), null);
    assert.equal(await load({ ...PHOTO, url: 'http://127.0.0.1:3101/heic', mimeType: 'image/heic', fileName: 'IMG.HEIC' }), 'data:image/jpeg;base64,CQ==');
    assert.equal(await load(PDF), null);
    assert.deepEqual(fetched.map((f) => f.key), ['k', 'k', 'k']);
    const noHeic = createImageLoader({ bridgeUrls: ['http://127.0.0.1:3101'], bridgeKey: 'k', fetchImpl, convertHeic: async () => { throw new Error('no sips'); } });
    assert.equal(await noHeic({ ...PHOTO, url: 'http://127.0.0.1:3101/heic', mimeType: 'image/heic' }), null);
});
