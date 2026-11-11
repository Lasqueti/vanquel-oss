import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createPipeline } from '../src/agent/pipeline.ts';
import { buildTools } from '../src/agent/tools.ts';
import { createRoutes } from '../src/app.ts';
import type { AppConfig } from '../src/app.ts';
import { findRoute, HttpError } from '../src/http.ts';
import type { Req, Res } from '../src/http.ts';
import { slackSignature } from '../src/channels/slack.ts';
import { nextStatus } from '../src/ops/line-watchdog.ts';
import { PERSON, quietLog, recordingChannel, say, scriptedLlm } from './helpers.ts';

function harness(overrides: Partial<AppConfig> = {}) {
    const store = openStore(':memory:');
    const imessage = recordingChannel('imessage');
    const slack = recordingChannel('slack', 'block');
    const router = createRouter(store, [imessage, slack]);
    const posted: Array<{ channel: string; text: string; thread?: string }> = [];
    const slackClient = { postMessage: async (channel: string, text: string, thread?: string) => { posted.push({ channel, text, thread }); return '111.222'; } };
    const pipeline = createPipeline({
        store, router, llm: scriptedLlm([say('hello from the agent'), say('second')]), tools: buildTools({ browse: false }), log: quietLog,
        operator: { notifyHandoff: async () => {}, forward: async () => {} },
        config: { agentName: 'Sam', businessName: 'Test Co', businessInfo: '', timeZone: 'UTC', historyLimit: 10, maxRepliesPerHour: 10, debounceMs: 0, maxToolRounds: 2 },
    });
    const routes = createRoutes({ store, pipeline, router, log: quietLog, config: {
        bridgeKey: 'bridge-key', adminToken: 'admin-token', publicBaseUrl: 'https://agent.example.com', workerSecret: 'worker-secret',
        slack: { signingSecret: 'signing', operatorChannel: 'COPS', client: slackClient }, ...overrides,
    } });
    async function call(method: string, path: string, body: unknown, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1'): Promise<Res> {
        const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
        const url = new URL(path, 'http://x');
        const req: Req = { method, path: url.pathname, query: url.searchParams, headers, rawBody: Buffer.from(raw), remoteAddress, url: path };
        try {
            return await findRoute(routes, method, url.pathname)!(req);
        } catch (error) {
            if (error instanceof HttpError) return { status: error.status, body: error.message };
            throw error;
        }
    }
    return { store, imessage, posted, pipeline, call };
}

test('bridges must present the bridge key; group chats are ignored', async () => {
    const h = harness();
    assert.equal((await h.call('POST', '/inbound/imessage', { line: 'mac', from: PERSON, text: 'hi', guid: 'g1' })).status, 401);
    const group = await h.call('POST', '/inbound/imessage', { line: 'mac', from: 'chat1', text: 'hi', guid: 'g2', isGroup: true }, { 'x-bridge-key': 'bridge-key' });
    assert.deepEqual(group.body, { result: 'ignored-group' });
    const ok = await h.call('POST', '/inbound/imessage', { line: 'mac', from: PERSON, text: 'hi', guid: 'g3' }, { 'x-bridge-key': 'bridge-key' });
    assert.deepEqual(ok.body, { result: 'scheduled' });
    await h.pipeline.idle();
    assert.equal(h.imessage.sent[0].text, 'hello from the agent');
});

test('admin API needs the token; operator replies are logged as the operator', async () => {
    const h = harness();
    h.store.touchContact({ channel: 'imessage', handle: PERSON });
    const body = { channel: 'imessage', handle: PERSON, text: 'Hi, this is Jo from the team.' };
    assert.equal((await h.call('POST', '/admin/reply', body)).status, 401);
    assert.equal((await h.call('POST', '/admin/reply', body, { authorization: 'Bearer admin-token' })).status, 200);
    assert.equal(h.store.recentMessages('imessage', PERSON, 5)[0].direction, 'operator');
    const slot = await h.call('POST', '/admin/slots', { startsAt: '2099-01-01T10:00:00Z', endsAt: '2099-01-01T10:30:00Z' }, { authorization: 'Bearer admin-token' });
    assert.equal(slot.status, 201);
    assert.equal((await h.call('POST', '/admin/slots', { startsAt: 'nope', endsAt: '' }, { authorization: 'Bearer admin-token' })).status, 400);
});

test('admin API is off without a token', async () => {
    const h = harness({ adminToken: '' });
    assert.equal((await h.call('GET', '/admin/slots', {}, { authorization: 'Bearer ' })).status, 403);
});

test('Slack: signed operator thread replies reach the customer; "done" hands back', async () => {
    const h = harness();
    h.store.touchContact({ channel: 'imessage', handle: PERSON });
    h.store.startHandoff('imessage', PERSON, 'refund');
    h.store.setOperatorThread('imessage', PERSON, '111.222');
    const signed = (event: Record<string, unknown>) => {
        const raw = JSON.stringify({ type: 'event_callback', event_id: `E${Math.random()}`, event });
        const ts = String(Math.floor(Date.now() / 1000));
        return [raw, { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature('signing', ts, raw) }] as const;
    };
    const [raw1, headers1] = signed({ type: 'message', channel: 'COPS', user: 'U1', text: 'Refund issued.', ts: '200.1', thread_ts: '111.222' });
    assert.equal((await h.call('POST', '/channels/slack/events', raw1, headers1)).status, 200);
    assert.equal(h.imessage.sent.at(-1)!.text, 'Refund issued.');
    const [raw2, headers2] = signed({ type: 'message', channel: 'COPS', user: 'U1', text: 'done', ts: '200.2', thread_ts: '111.222' });
    await h.call('POST', '/channels/slack/events', raw2, headers2);
    assert.equal(h.store.getContact('imessage', PERSON)!.handoffSince, null);
    assert.equal(h.posted.at(-1)!.text, 'Handed back to the agent.');
    assert.equal((await h.call('POST', '/channels/slack/events', raw2, { ...headers2, 'x-slack-signature': 'v0=bad' })).status, 403);
});

test('browse results are accepted only from loopback with the secret, and texted once', async () => {
    const h = harness();
    h.store.touchContact({ channel: 'imessage', handle: PERSON });
    h.store.addBrowseTask({ id: 't1', channel: 'imessage', handle: PERSON, goal: 'hours', status: 'running' });
    const body = { id: 't1', status: 'done', summary: 'They open at 9.' };
    assert.equal((await h.call('POST', '/internal/browse-result', body, { 'x-worker-secret': 'worker-secret' }, '203.0.113.9')).status, 403);
    assert.equal((await h.call('POST', '/internal/browse-result', body, { 'x-worker-secret': 'worker-secret' })).status, 200);
    await h.call('POST', '/internal/browse-result', body, { 'x-worker-secret': 'worker-secret' });
    assert.deepEqual(h.imessage.sent.map((s) => s.text), ['They open at 9.']);
});

test('watchdog alerts once after three misses, and once on recovery', () => {
    let status = { misses: 0, alerted: false };
    const events: Array<string | null> = [];
    for (const healthy of [false, false, false, false, true, true]) {
        const next = nextStatus(status, healthy);
        status = next.status;
        events.push(next.event);
    }
    assert.deepEqual(events, [null, null, 'down', null, 'recovered', null]);
});
