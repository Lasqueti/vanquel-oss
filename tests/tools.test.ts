import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { buildTools } from '../src/agent/tools.ts';
import type { ToolContext } from '../src/agent/tools.ts';
import { createRouter } from '../src/channels/router.ts';
import { createReminderRunner } from '../src/reminders.ts';
import { OTHER, PERSON, recordingChannel } from './helpers.ts';

const NOW = new Date('2030-06-01T12:00:00Z');

function context(handle = PERSON, store = openStore(':memory:', () => NOW)): ToolContext {
    return {
        address: { channel: 'imessage', handle },
        store,
        now: () => NOW,
        operator: { notifyHandoff: async () => {}, forward: async () => {} },
        lastUserText: '',
    };
}

const tools = Object.fromEntries(buildTools({ browse: true }).map((t) => [t.schema.function.name, t]));

test('reminders need an explicit offset and a future time', async () => {
    const ctx = context();
    assert.match(await tools.set_reminder.run({ text: 'x', at: '2030-06-01T15:00:00' }, ctx), /UTC offset/);
    assert.match(await tools.set_reminder.run({ text: 'x', at: '2030-05-01T15:00:00Z' }, ctx), /past/);
    assert.match(await tools.set_reminder.run({ text: 'x', at: '2032-06-01T15:00:00Z' }, ctx), /a year/);
    assert.match(await tools.set_reminder.run({ text: 'call mom', at: '2030-06-01T09:00:00-05:00' }, ctx), /scheduled for 2030-06-01T14:00:00.000Z/);
    assert.match(await tools.list_reminders.run({}, ctx), /call mom/);
});

test('a person can only cancel their own reminders', async () => {
    const store = openStore(':memory:', () => NOW);
    const mine = context(PERSON, store);
    const theirs = context(OTHER, store);
    await tools.set_reminder.run({ text: 'x', at: '2030-07-01T00:00:00Z' }, mine);
    assert.match(await tools.cancel_reminder.run({ id: 1 }, theirs), /No such/);
    assert.equal(await tools.cancel_reminder.run({ id: 1 }, mine), 'Cancelled.');
});

test('a slot can be booked once, and only cancelled by whoever booked it', async () => {
    const store = openStore(':memory:', () => NOW);
    const id = store.addSlot('2030-06-02T10:00:00-04:00', '2030-06-02T10:30:00-04:00', 'Consult');
    const a = context(PERSON, store);
    const b = context(OTHER, store);
    assert.match(await tools.list_open_slots.run({}, a), /slot 1: 2030-06-02T14:00:00.000Z/);
    assert.equal(await tools.book_slot.run({ slot_id: id, note: 'Alex' }, a), `Booked slot ${id}.`);
    assert.match(await tools.book_slot.run({ slot_id: id }, b), /not available/);
    assert.match(await tools.cancel_booking.run({ slot_id: id }, b), /No such/);
    assert.equal(await tools.cancel_booking.run({ slot_id: id }, a), 'Booking cancelled.');
});

test('past slots cannot be booked', async () => {
    const store = openStore(':memory:', () => NOW);
    const id = store.addSlot('2030-05-01T10:00:00Z', '2030-05-01T11:00:00Z', '');
    assert.match(await tools.book_slot.run({ slot_id: id }, context(PERSON, store)), /not available/);
});

test('browse_web without a worker says so instead of pretending', async () => {
    assert.match(await tools.browse_web.run({ goal: 'find hours' }, context()), /not configured/);
});

test('due reminders are sent once; failures retry then alert', async () => {
    let clock = new Date('2030-06-01T12:00:00Z');
    const store = openStore(':memory:', () => clock);
    const channel = recordingChannel();
    const router = createRouter(store, [channel]);
    const alerts: string[] = [];
    const runner = createReminderRunner(store, router, async (m) => { alerts.push(m); });
    store.touchContact({ channel: 'imessage', handle: PERSON });
    store.addReminder('imessage', PERSON, 'take your meds', '2030-06-01T12:05:00.000Z');
    assert.equal(await runner.tick(), 0);
    clock = new Date('2030-06-01T12:06:00Z');
    assert.equal(await runner.tick(), 1);
    assert.equal(await runner.tick(), 0);
    assert.deepEqual(channel.sent.map((s) => s.text), ['take your meds']);

    // A reminder for someone who never texted is refused by the router, retried, then alerted.
    store.addReminder('imessage', OTHER, 'spam', '2030-06-01T12:00:00.000Z');
    await runner.tick();
    await runner.tick();
    await runner.tick();
    assert.equal(alerts.length, 1);
    assert.equal(channel.sent.length, 1);
});
