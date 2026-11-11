import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createPipeline, keyword } from '../src/agent/pipeline.ts';
import type { PipelineConfig } from '../src/agent/pipeline.ts';
import { buildTools } from '../src/agent/tools.ts';
import type { Operator } from '../src/agent/tools.ts';
import type { Llm } from '../src/agent/llm.ts';
import { PERSON, callTool, quietLog, recordingChannel, say, scriptedLlm } from './helpers.ts';

const config: PipelineConfig = { agentName: 'Sam', businessName: 'Test Co', businessInfo: 'Open 9 to 5.', timeZone: 'UTC', historyLimit: 30, maxRepliesPerHour: 30, debounceMs: 0, maxToolRounds: 5 };

function setup(llm: Llm, overrides: Partial<PipelineConfig> = {}) {
    const store = openStore(':memory:');
    const channel = recordingChannel();
    const router = createRouter(store, [channel]);
    const handoffs: string[] = [];
    const forwarded: string[] = [];
    const operator: Operator = {
        notifyHandoff: async (_a, reason) => {
            handoffs.push(reason);
        },
        forward: async (_a, text) => {
            forwarded.push(text);
        },
    };
    const pipeline = createPipeline({ store, router, llm, tools: buildTools({ browse: false }), operator, log: quietLog, config: { ...config, ...overrides } });
    const inbound = (text: string, id?: string) => pipeline.handleInbound({ address: { channel: 'imessage', handle: PERSON, line: 'mac' }, text, externalId: id });
    return { store, channel, pipeline, inbound, handoffs, forwarded };
}

test('a text gets one reply, out the line it came in on', async () => {
    const t = setup(scriptedLlm([say('Hi! We open at 9.')]));
    assert.equal(await t.inbound('when do you open', 'g1'), 'scheduled');
    await t.pipeline.idle();
    assert.deepEqual(t.channel.sent.map((s) => [s.text, s.address.line]), [['Hi! We open at 9.', 'mac']]);
});

test('the same message id is handled once', async () => {
    const t = setup(scriptedLlm([say('one'), say('two')]));
    await t.inbound('hello', 'dup');
    assert.equal(await t.inbound('hello', 'dup'), 'duplicate');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.length, 1);
});

test('blank lines split a reply into separate bubbles', async () => {
    const t = setup(scriptedLlm([say('First thought.\n\nSecond thought.')]));
    await t.inbound('hey');
    await t.pipeline.idle();
    assert.deepEqual(t.channel.sent.map((s) => s.text), ['First thought.', 'Second thought.']);
});

test('STOP opts out with one confirmation, then silence until START', async () => {
    const llm = scriptedLlm([say('welcome back')]);
    const t = setup(llm);
    await t.inbound('first message');
    await t.pipeline.idle();
    const before = t.channel.sent.length;
    assert.equal(await t.inbound('STOP'), 'keyword');
    assert.match(t.channel.sent.at(-1)!.text, /unsubscribed/);
    assert.equal(await t.inbound('are you there?'), 'opted-out');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.length, before + 1);
    assert.equal(await t.inbound('start'), 'keyword');
    assert.match(t.channel.sent.at(-1)!.text, /resubscribed/);
});

test('keyword matching is exact, so "stop by tomorrow" is a normal message', () => {
    assert.equal(keyword('Stop.'), 'stop');
    assert.equal(keyword('stop by tomorrow'), null);
    assert.equal(keyword('cancel'), null);
});

test('handoff notifies the operator and the agent goes quiet', async () => {
    const t = setup(scriptedLlm([callTool('handoff_to_human', { reason: 'wants a refund' }), say('A teammate will reply here soon.')]));
    await t.inbound('I want a refund');
    await t.pipeline.idle();
    assert.deepEqual(t.handoffs, ['wants a refund']);
    assert.equal(t.channel.sent.at(-1)!.text, 'A teammate will reply here soon.');
    assert.equal(await t.inbound('hello?'), 'handed-off');
    assert.deepEqual(t.forwarded, ['hello?']);
    t.store.endHandoff('imessage', PERSON);
    assert.equal(await t.inbound('thanks'), 'scheduled');
});

test('replies per hour are capped per person', async () => {
    const t = setup(scriptedLlm([say('a'), say('b'), say('c')]), { maxRepliesPerHour: 2 });
    await t.inbound('1');
    await t.pipeline.idle();
    await t.inbound('2');
    await t.pipeline.idle();
    assert.equal(await t.inbound('3'), 'rate-limited');
});

test('a model failure sends a safe fallback instead of nothing', async () => {
    const t = setup({ chat: async () => { throw new Error('boom'); } });
    await t.inbound('hi');
    await t.pipeline.idle();
    assert.match(t.channel.sent[0].text, /something went wrong/);
});

test('debounce answers a burst of texts once', async () => {
    const llm = scriptedLlm([say('got all three')]);
    const t = setup(llm, { debounceMs: 30 });
    await t.inbound('hey');
    await t.inbound('one more thing');
    await t.inbound('actually two');
    await t.pipeline.idle();
    assert.equal(t.channel.sent.length, 1);
    const history = llm.calls[0].filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(history, ['hey', 'one more thing', 'actually two']);
});

test('tool results reach the model and the reminder is stored', async () => {
    const llm = scriptedLlm([callTool('set_reminder', { text: 'Dentist at 3', at: new Date(Date.now() + 30 * 86_400_000).toISOString() }), say('Done, I will remind you.')]);
    const t = setup(llm);
    await t.inbound('remind me about the dentist');
    await t.pipeline.idle();
    const toolMessage = llm.calls[1].find((m) => m.role === 'tool');
    assert.match(String(toolMessage?.content), /Reminder 1 scheduled/);
    assert.equal(t.store.listReminders('imessage', PERSON).length, 1);
});
