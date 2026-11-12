import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createPipeline } from '../src/agent/pipeline.ts';
import type { PipelineConfig } from '../src/agent/pipeline.ts';
import { buildTools } from '../src/agent/tools.ts';
import type { Llm } from '../src/agent/llm.ts';
import type { InboundMessage } from '../src/channels/types.ts';
import { isSmsGroup, isTextTapback, namesAgent } from '../src/agent/attention.ts';
import { GROUP, OTHER, PERSON, THIRD, quietLog, recordingChannel, say, scriptedLlm, textOf } from './helpers.ts';

const config: PipelineConfig = { agentName: 'Sam', businessName: 'Test Co', businessInfo: 'Open 9 to 5.', timeZone: 'UTC', historyLimit: 30, maxRepliesPerHour: 30, debounceMs: 0, maxToolRounds: 5 };

function setup(llm: Llm, overrides: Partial<PipelineConfig> = {}) {
    let clock = new Date('2030-06-01T12:00:00Z');
    const store = openStore(':memory:', () => clock);
    const channel = recordingChannel();
    const router = createRouter(store, [channel]);
    const pipeline = createPipeline({
        store, router, llm, tools: buildTools({ browse: false }), log: quietLog, now: () => clock,
        operator: { notifyHandoff: async () => {}, forward: async () => {} },
        config: { ...config, ...overrides },
    });
    let id = 0;
    const group = (sender: string, text: string, extra: Partial<InboundMessage> = {}) => {
        id += 1;
        return pipeline.handleInbound({ address: { channel: 'imessage', handle: GROUP, line: 'mac', group: true }, text, sender, externalId: `g${id}`, ...extra });
    };
    const dm = (handle: string, text: string) => pipeline.handleInbound({ address: { channel: 'imessage', handle, line: 'mac' }, text });
    const advance = (ms: number) => {
        clock = new Date(clock.getTime() + ms);
    };
    return { store, channel, router, pipeline, group, dm, advance };
}

test('a group is answered in the group, and only when the agent is named', async () => {
    const llm = scriptedLlm([say('We open at 9.')]);
    const t = setup(llm);
    assert.equal(await t.group(PERSON, 'anyone up for lunch'), 'quiet');
    assert.equal(await t.group(OTHER, 'everyone, what time do they open?'), 'quiet');
    assert.equal(await t.group(OTHER, 'sam what time do you open?'), 'scheduled');
    await t.pipeline.idle();
    assert.deepEqual(t.channel.sent.map((s) => [s.address.handle, s.text]), [[GROUP, 'We open at 9.']]);
    assert.equal(t.channel.typed[0].handle, GROUP);

    // The model read one shared transcript, members labelled by their last four digits.
    const users = llm.calls[0].filter((m) => m.role === 'user').map((m) => textOf(m.content));
    assert.deepEqual(users, ['...0123: anyone up for lunch', '...0199: everyone, what time do they open?', '...0199: sam what time do you open?']);
    const system = textOf(llm.calls[0][0].content);
    assert.match(system, /group chat/);
    assert.match(system, /Tools available: none/);

    // Being in a group with someone is not them messaging us.
    assert.equal(t.store.getContact('imessage', PERSON), null);
    await assert.rejects(t.router.send({ channel: 'imessage', handle: PERSON }, 'hi'), /never messaged us/);
});

test('answering the agent\'s question needs no name; a statement closes the window', async () => {
    const t = setup(scriptedLlm([say('Which day works for you all?'), say('Friday it is.')]));
    await t.group(PERSON, 'Sam can you help us pick a day');
    await t.pipeline.idle();
    assert.equal(await t.group(OTHER, 'friday'), 'scheduled');
    await t.pipeline.idle();
    assert.equal(await t.group(THIRD, 'nice, thanks'), 'quiet');
    assert.deepEqual(t.channel.sent.map((s) => s.text), ['Which day works for you all?', 'Friday it is.']);
});

test('the window shuts after six member messages, or thirty quiet minutes', async () => {
    const t = setup(scriptedLlm([say('Which day?'), ...Array.from({ length: 6 }, () => say('NO_REPLY'))]));
    await t.group(PERSON, 'sam pick a day for us');
    await t.pipeline.idle();
    for (let i = 1; i <= 6; i += 1) assert.equal(await t.group(OTHER, `chatter ${i}`), 'scheduled');
    await t.pipeline.idle();
    assert.equal(await t.group(OTHER, 'chatter 7'), 'quiet');
    // NO_REPLY is silence, never a message.
    assert.deepEqual(t.channel.sent.map((s) => s.text), ['Which day?']);

    const late = setup(scriptedLlm([say('Which day?')]));
    await late.group(PERSON, 'sam pick a day');
    await late.pipeline.idle();
    late.advance(31 * 60 * 1000);
    assert.equal(await late.group(OTHER, 'friday'), 'quiet');
});

test('an SMS group is left quietly, for good, with nothing stored', async () => {
    const t = setup(scriptedLlm([]));
    assert.equal(await t.group(PERSON, 'sam hi', { service: 'SMS' }), 'left-group');
    assert.equal(await t.group(PERSON, 'sam are you there?'), 'left-group');
    assert.equal(t.channel.sent.length, 0);
    assert.deepEqual(t.store.recentMessages('imessage', GROUP, 10), []);
    await assert.rejects(t.router.send({ channel: 'imessage', handle: GROUP }, 'hi'), /left this group/);
    assert.ok(isSmsGroup(undefined, 'SMS;-;chat200002'));
    assert.ok(isSmsGroup('rcs', 'chat1'));
    assert.ok(!isSmsGroup('iMessage', 'iMessage;+;chat1'));
    assert.ok(!isSmsGroup(undefined, 'chat1'));
});

test('STOP in a group quiets the group; a member who opted out never wakes the agent', async () => {
    const t = setup(scriptedLlm([say('hello'), say('hi there')]));
    await t.dm(PERSON, 'hello');
    await t.pipeline.idle();
    await t.dm(PERSON, 'STOP');
    assert.equal(await t.group(PERSON, 'sam you there?'), 'quiet');
    assert.equal(await t.group(OTHER, 'sam you there?'), 'scheduled');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.at(-1)!.address.handle, GROUP);

    assert.equal(await t.group(THIRD, 'stop'), 'keyword');
    assert.match(t.channel.sent.at(-1)!.text, /stay out of this chat/);
    assert.equal(t.channel.sent.at(-1)!.address.handle, GROUP);
    assert.equal(await t.group(OTHER, 'sam?'), 'opted-out');
});

test('a group never sees a member\'s private conversation, and gets no tools', async () => {
    const llm = scriptedLlm([say('noted'), say('hey all')]);
    const t = setup(llm);
    await t.dm(PERSON, 'my door code is 4242');
    await t.pipeline.idle();
    await t.group(PERSON, 'sam say hi to everyone');
    await t.pipeline.idle();
    const seen = llm.calls[1].map((m) => textOf(m.content)).join('\n');
    assert.doesNotMatch(seen, /4242/);
    assert.equal(t.channel.sent.at(-1)!.address.handle, GROUP);
});

test('a model failure in a group is silence, not an apology to the room', async () => {
    const t = setup({ chat: async () => { throw new Error('boom'); } });
    await t.group(PERSON, 'sam hello');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.length, 0);
});

test('the reply cap counts per group', async () => {
    const t = setup(scriptedLlm([say('a'), say('b')]), { maxRepliesPerHour: 1 });
    await t.group(PERSON, 'sam one');
    await t.pipeline.idle();
    assert.equal(await t.group(OTHER, 'sam two'), 'rate-limited');
});

test('a tapback in a group is context, never a turn', async () => {
    const llm = scriptedLlm([say('Which day?'), say('ok')]);
    const t = setup(llm);
    await t.group(PERSON, 'sam pick a day');
    await t.pipeline.idle();
    assert.equal(await t.group(OTHER, 'Loved \u201CWhich day?\u201D'), 'reaction');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.length, 1);
});

test('the agent\'s name is matched as a whole word, stretched or not', () => {
    assert.ok(namesAgent('SAMM, settle this', 'Sam'));
    assert.ok(namesAgent('where is @sam', 'Sam'));
    assert.ok(namesAgent('ask Front Desk', 'Front Desk'));
    assert.ok(!namesAgent('same here', 'Sam'));
    assert.ok(!namesAgent('samantha said so', 'Sam'));
    assert.ok(!namesAgent('hey everyone', 'Sam'));
    assert.ok(!namesAgent('anything', ''));
    assert.ok(isTextTapback('Liked "see you at 3"'));
    assert.ok(isTextTapback('Reacted \u{1F44D} to \u201Cok\u201D'));
    assert.ok(isTextTapback('Removed a heart from "hi"'));
    assert.ok(!isTextTapback('Liked the workout today'));
    assert.ok(!isTextTapback('Loved "Dune" so much'));
});
