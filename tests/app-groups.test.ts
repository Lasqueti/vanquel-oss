import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createPipeline } from '../src/agent/pipeline.ts';
import { buildTools } from '../src/agent/tools.ts';
import { createRoutes } from '../src/app.ts';
import { findRoute } from '../src/http.ts';
import type { Req, Res } from '../src/http.ts';
import { GROUP, OTHER, PERSON, quietLog, recordingChannel, say, scriptedLlm } from './helpers.ts';

function harness() {
    const store = openStore(':memory:');
    const imessage = recordingChannel('imessage');
    const router = createRouter(store, [imessage]);
    const pipeline = createPipeline({
        store, router, llm: scriptedLlm([say('Hi all!'), say('Hi you!')]), tools: buildTools({ browse: false }), log: quietLog,
        operator: { notifyHandoff: async () => {}, forward: async () => {} },
        config: { agentName: 'Sam', businessName: 'Test Co', businessInfo: '', timeZone: 'UTC', historyLimit: 10, maxRepliesPerHour: 10, debounceMs: 0, maxToolRounds: 2 },
    });
    const routes = createRoutes({ store, pipeline, router, log: quietLog, config: { bridgeKey: 'bridge-key', adminToken: '', publicBaseUrl: 'https://agent.example.com' } });
    async function inbound(body: Record<string, unknown>): Promise<Res> {
        const req: Req = { method: 'POST', path: '/inbound/imessage', query: new URLSearchParams(), headers: { 'x-bridge-key': 'bridge-key' }, rawBody: Buffer.from(JSON.stringify(body)), remoteAddress: '127.0.0.1', url: '/inbound/imessage' };
        return findRoute(routes, 'POST', '/inbound/imessage')!(req);
    }
    return { store, imessage, pipeline, inbound };
}

test('a group message is stored on the group and answered to the group', async () => {
    const h = harness();
    const quiet = await h.inbound({ line: 'mac', from: PERSON, text: 'lunch?', guid: 'g1', isGroup: true, chat: GROUP, service: 'iMessage' });
    assert.deepEqual(quiet.body, { result: 'quiet' });
    const named = await h.inbound({ line: 'mac', from: OTHER, text: 'sam say hi', guid: 'g2', isGroup: true, chat: GROUP });
    assert.deepEqual(named.body, { result: 'scheduled' });
    await h.pipeline.idle();
    assert.deepEqual(h.imessage.sent.map((s) => [s.address.handle, s.address.line, s.text]), [[GROUP, 'mac', 'Hi all!']]);
    assert.deepEqual(h.store.recentMessages('imessage', GROUP, 5).filter((m) => m.direction === 'in').map((m) => m.sender), [PERSON, OTHER]);
    assert.equal(h.store.getContact('imessage', GROUP)!.isGroup, true);
    assert.equal(h.store.getContact('imessage', OTHER), null);
});

test('groups without a chat id are ignored; SMS groups are left; photos reach the pipeline', async () => {
    const h = harness();
    assert.deepEqual((await h.inbound({ line: 'mac', from: PERSON, text: 'sam hi', guid: 'g1', isGroup: true })).body, { result: 'ignored-group' });
    assert.deepEqual((await h.inbound({ line: 'phone1', from: PERSON, text: 'sam hi', guid: 'g2', isGroup: true, chat: 'chat777', service: 'SMS' })).body, { result: 'left-group' });
    const photo = await h.inbound({ line: 'mac', from: PERSON, text: '', guid: 'g3', attachments: [{ url: 'http://127.0.0.1:3101/a/1', mimeType: 'image/jpeg', fileName: 'IMG.jpeg' }] });
    assert.deepEqual(photo.body, { result: 'scheduled' });
    await h.pipeline.idle();
    assert.equal(h.store.recentMessages('imessage', PERSON, 5)[0].attachments[0].fileName, 'IMG.jpeg');
    assert.equal(h.imessage.sent.length, 1);
});
