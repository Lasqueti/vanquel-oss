import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { createRouter } from '../src/channels/router.ts';
import { createPipeline } from '../src/agent/pipeline.ts';
import { buildTools } from '../src/agent/tools.ts';
import type { ToolContext } from '../src/agent/tools.ts';
import { createRoutes } from '../src/app.ts';
import { findRoute } from '../src/http.ts';
import type { Req } from '../src/http.ts';
import type { Card } from '../src/cards/cards.ts';
import { bookingCard, captionFor, confirmCard, remindersCard, resultCard } from '../src/cards/cards.ts';
import { cardDocument, cardWidth } from '../src/cards/designs.ts';
import type { CardRenderer } from '../src/cards/render.ts';
import { PERSON, callTool, quietLog, recordingChannel, say, scriptedLlm } from './helpers.ts';

const NOW = new Date('2030-03-04T15:00:00Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const address = { channel: 'imessage' as const, handle: PERSON };

// Draws nothing; remembers what it was asked to draw.
function fakeRenderer(fail = false): CardRenderer & { drawn: Card[] } {
    const drawn: Card[] = [];
    return {
        drawn,
        async render(card) {
            if (fail) throw new Error('no chrome');
            drawn.push(card);
            return `/media/card-${drawn.length}.png`;
        },
        async close() {},
    };
}

test('booking and reminder cards come from the store, never from the model', () => {
    const store = openStore(':memory:');
    assert.equal(bookingCard(store, address, NOW), null);
    assert.equal(remindersCard(store, address), null);
    const past = store.addSlot(hours(-5), hours(-4), 'Old haircut');
    const soon = store.addSlot(hours(26), hours(26.75), 'Haircut');
    const other = store.addSlot(hours(2), hours(3), 'Not theirs');
    store.book(past, 'imessage', PERSON, '');
    store.book(soon, 'imessage', PERSON, '');
    store.book(other, 'imessage', '+15550100199', '');
    assert.deepEqual(bookingCard(store, address, NOW), { type: 'booking', rows: [{ at: hours(26), title: 'Haircut', meta: '45 min' }] });
    store.addReminder('imessage', PERSON, 'Bring the\nform', hours(1));
    assert.deepEqual(remindersCard(store, address), { type: 'reminders', rows: [{ at: hours(1), title: 'Bring the form' }] });
});

test('confirm and result cards are trimmed, capped, and refused when empty', () => {
    assert.equal(confirmCard({ title: 'Book?', details: [] }), null);
    assert.equal(confirmCard({ title: '', details: [{ label: 'When', value: 'Thu' }] }), null);
    const card = confirmCard({ title: '  Book   this? ', details: [{ label: 'When', value: 'Thu 3pm' }, { label: '', value: 'x' }, 'junk'] });
    assert.deepEqual(card, { type: 'confirm', title: 'Book this?', details: [{ label: 'When', value: 'Thu 3pm' }], ask: 'Reply YES to confirm' });
    const many = resultCard({ title: 'x'.repeat(200), items: Array.from({ length: 30 }, (_, i) => ({ name: `Store ${i}`, price: '$1' })).concat([{ name: '', price: '$2' }]) });
    assert.ok(many && many.type === 'result');
    assert.equal(many.title.length, 80);
    assert.equal(many.items.length, 12);
    assert.equal(resultCard({ title: 'Found', items: [{ detail: 'no name' }] }), null);
    assert.equal(captionFor(card!), 'Book this?');
});

test('the card page escapes everything and has no scripts or outside loads', () => {
    const evil = '<script>alert(1)</script><img src="https://evil.example/x">';
    const html = cardDocument({ type: 'result', title: evil, subtitle: evil, items: [{ name: evil, detail: evil, price: evil }] }, { theme: 'dark', timeZone: 'UTC', now: NOW });
    assert.doesNotMatch(html, /<script|<img|src="/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /data-theme="dark"/);
});

test('agenda cards label days and show a countdown only for what is soon', () => {
    const card: Card = { type: 'reminders', rows: [{ at: hours(1), title: 'Call back' }, { at: hours(25), title: 'Pay rent' }, { at: hours(72), title: 'Dentist' }] };
    const html = cardDocument(card, { theme: 'light', timeZone: 'UTC', now: NOW });
    assert.match(html, />Today</);
    assert.match(html, />Tomorrow</);
    assert.match(html, />Thu, Mar 7</);
    assert.equal(html.match(/class="t-chip"/g)?.length, 1);
    assert.match(html, /Next up Call back · in 1h/);
    assert.equal(cardWidth(card), 660);
    assert.equal(cardWidth({ type: 'result', title: 't', items: [{ name: 'n' }] }), 480);
});

test('send_card is offered only with cards on, works only over iMessage, and checks its card', async () => {
    assert.ok(!buildTools({ browse: false }).some((t) => t.schema.function.name === 'send_card'));
    const tool = buildTools({ browse: false, cards: true }).find((t) => t.schema.function.name === 'send_card')!;
    const store = openStore(':memory:');
    const ctx = (channel: ToolContext['address']['channel'], turn: ToolContext['turn']): ToolContext => ({
        address: { channel, handle: PERSON }, store, now: () => NOW, operator: { notifyHandoff: async () => {}, forward: async () => {} }, lastUserText: '', turn,
    });
    const turn: NonNullable<ToolContext['turn']> = { voiceNote: false };
    assert.match(await tool.run({ type: 'booking' }, ctx('email', turn)), /only go out over iMessage/);
    assert.match(await tool.run({ type: 'booking' }, ctx('imessage', turn)), /nothing to show/);
    assert.match(await tool.run({ type: 'confirm', title: 'Book?' }, ctx('imessage', turn)), /needs a title and at least one detail/);
    assert.equal(turn.card, undefined);
    assert.match(await tool.run({ type: 'confirm', title: 'Book?', details: [{ label: 'When', value: 'Thu' }] }, ctx('imessage', turn)), /sent right after your reply/);
    assert.equal((turn.card as Card | undefined)?.type, 'confirm');
});

test('the pipeline sends the card after the words, and a failed card loses nothing', async () => {
    for (const fail of [false, true]) {
        const store = openStore(':memory:');
        const channel = recordingChannel();
        const cards = fakeRenderer(fail);
        const pipeline = createPipeline({
            store, router: createRouter(store, [channel]), tools: buildTools({ browse: false, cards: true }), cards, log: quietLog,
            llm: scriptedLlm([callTool('send_card', { type: 'confirm', title: 'Book this?', details: [{ label: 'When', value: 'Thu 3pm' }] }), say('Want me to book it?')]),
            operator: { notifyHandoff: async () => {}, forward: async () => {} },
            config: { agentName: 'Sam', businessName: 'Test Co', businessInfo: '', timeZone: 'UTC', historyLimit: 10, maxRepliesPerHour: 10, debounceMs: 0, maxToolRounds: 3 },
        });
        await pipeline.handleInbound({ address: { channel: 'imessage', handle: PERSON, line: 'mac' }, text: 'can I get thursday at 3' });
        await pipeline.idle();
        assert.deepEqual(channel.sent.map((s) => s.text), ['Want me to book it?']);
        assert.deepEqual(channel.files.map((f) => f.files), fail ? [] : [['/media/card-1.png']]);
        const log = store.recentMessages('imessage', PERSON, 10).map((m) => m.text);
        assert.equal(log.includes('[card: Book this?]'), !fail);
    }
});

test('a web task that found a list sends a result card after its summary', async () => {
    const store = openStore(':memory:');
    const imessage = recordingChannel('imessage');
    const router = createRouter(store, [imessage]);
    const cards = fakeRenderer();
    const pipeline = createPipeline({
        store, router, llm: scriptedLlm([]), tools: [], log: quietLog, operator: { notifyHandoff: async () => {}, forward: async () => {} },
        config: { agentName: 'Sam', businessName: 'Test Co', businessInfo: '', timeZone: 'UTC', historyLimit: 10, maxRepliesPerHour: 10, debounceMs: 0, maxToolRounds: 2 },
    });
    const routes = createRoutes({ store, pipeline, router, log: quietLog, cards, config: { bridgeKey: 'k', adminToken: '', publicBaseUrl: '', workerSecret: 'worker-secret' } });
    store.touchContact({ channel: 'imessage', handle: PERSON, line: 'mac' });
    store.addBrowseTask({ id: 't1', channel: 'imessage', handle: PERSON, goal: 'late hardware stores', status: 'running' });
    const body = { id: 't1', status: 'done', summary: 'Three are open late.', found: { title: '', items: [{ name: 'Corner Hardware', detail: 'until 9 PM' }] } };
    const req: Req = { method: 'POST', path: '/internal/browse-result', query: new URLSearchParams(), headers: { 'x-worker-secret': 'worker-secret' }, rawBody: Buffer.from(JSON.stringify(body)), remoteAddress: '127.0.0.1', url: '/internal/browse-result' };
    assert.equal((await findRoute(routes, 'POST', '/internal/browse-result')!(req)).status, 200);
    assert.deepEqual(imessage.sent.map((s) => s.text), ['Three are open late.']);
    assert.deepEqual(cards.drawn, [{ type: 'result', title: 'late hardware stores', items: [{ name: 'Corner Hardware', detail: 'until 9 PM' }] }]);
    assert.equal(imessage.files.length, 1);
});
