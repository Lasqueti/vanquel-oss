// src/agent/tools.ts
// What the agent can do besides talk. Each tool validates its own arguments
// and returns a short plain-text result the model reads on its next step.
// Tools only ever act for the person in the conversation (ctx.address).

import { createHash, randomUUID } from 'node:crypto';
import type { Address } from '../channels/types.ts';
import type { Store } from '../store.ts';
import type { ToolSchema } from './llm.ts';

export interface Operator {
    notifyHandoff(address: Address, reason: string, lastText: string): Promise<void>;
    forward(address: Address, text: string): Promise<void>;
}

export interface BrowseClient {
    start(task: { id: string; goal: string; startUrl?: string; profile: string }): Promise<void>;
}

export interface ToolContext {
    address: Address;
    store: Store;
    now: () => Date;
    operator: Operator;
    browse?: BrowseClient;
    lastUserText: string;
    // How this turn's reply goes out. A tool may change it.
    turn?: { voiceNote: boolean };
}

export interface Tool {
    schema: ToolSchema;
    run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const MAX_REMINDERS_PER_PERSON = 20;
const MAX_REMINDER_AHEAD_MS = 366 * 24 * 3600 * 1000;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: Tool['run']): Tool {
    return { schema: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }, run };
}

// The browser profile directory name: a hash, so handles never land on disk.
function profileName(address: Address): string {
    return createHash('sha256').update(`${address.channel}:${address.handle}`).digest('hex').slice(0, 24);
}

function parseTime(value: unknown): Date | null {
    const text = String(value ?? '');
    // Require an explicit offset or Z, so "9am" is never silently UTC.
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

const setReminder = tool('set_reminder', 'Schedule a text to this person at a future time.', {
    text: { type: 'string', description: 'What the reminder should say.' },
    at: { type: 'string', description: 'ISO 8601 time with UTC offset, e.g. 2030-01-31T09:00:00-05:00' },
}, ['text', 'at'], async (args, ctx) => {
    const at = parseTime(args.at);
    const text = String(args.text ?? '').trim().slice(0, 500);
    if (!text) return 'Error: reminder text is empty.';
    if (!at) return 'Error: "at" must be ISO 8601 with a UTC offset.';
    const delta = at.getTime() - ctx.now().getTime();
    if (delta <= 0) return 'Error: that time is in the past.';
    if (delta > MAX_REMINDER_AHEAD_MS) return 'Error: reminders can be at most a year ahead.';
    if (ctx.store.listReminders(ctx.address.channel, ctx.address.handle).length >= MAX_REMINDERS_PER_PERSON) return 'Error: this person already has the maximum number of reminders.';
    const id = ctx.store.addReminder(ctx.address.channel, ctx.address.handle, text, at.toISOString());
    return `Reminder ${id} scheduled for ${at.toISOString()}.`;
});

const listReminders = tool('list_reminders', "List this person's upcoming reminders.", {}, [], async (_args, ctx) => {
    const reminders = ctx.store.listReminders(ctx.address.channel, ctx.address.handle);
    if (!reminders.length) return 'No upcoming reminders.';
    return reminders.map((r) => `#${r.id} at ${r.dueAt}: ${r.text}`).join('\n');
});

const cancelReminder = tool('cancel_reminder', 'Cancel one of this person\'s reminders by id.', {
    id: { type: 'integer' },
}, ['id'], async (args, ctx) => {
    return ctx.store.cancelReminder(ctx.address.channel, ctx.address.handle, Number(args.id)) ? 'Cancelled.' : 'No such upcoming reminder for this person.';
});

const listSlots = tool('list_open_slots', 'List open appointment slots, soonest first.', {
    limit: { type: 'integer', description: 'How many to show, at most 10.' },
}, [], async (args, ctx) => {
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    const slots = ctx.store.openSlots(ctx.now().toISOString(), limit);
    if (!slots.length) return 'No open slots.';
    return slots.map((s) => `slot ${s.id}: ${s.startsAt} to ${s.endsAt}${s.label ? ` (${s.label})` : ''}`).join('\n');
});

const bookSlot = tool('book_slot', 'Book an open slot for this person. Confirm with them first.', {
    slot_id: { type: 'integer' },
    note: { type: 'string', description: 'Name and reason, as the person gave them.' },
}, ['slot_id'], async (args, ctx) => {
    const ok = ctx.store.book(Number(args.slot_id), ctx.address.channel, ctx.address.handle, String(args.note ?? '').slice(0, 300));
    return ok ? `Booked slot ${args.slot_id}.` : 'That slot is not available any more. List open slots again.';
});

const myBookings = tool('list_my_bookings', "List this person's booked slots.", {}, [], async (_args, ctx) => {
    const slots = ctx.store.bookingsFor(ctx.address.channel, ctx.address.handle);
    return slots.length ? slots.map((s) => `slot ${s.id}: ${s.startsAt} to ${s.endsAt}`).join('\n') : 'No bookings.';
});

const cancelBooking = tool('cancel_booking', 'Cancel one of this person\'s bookings. Confirm with them first.', {
    slot_id: { type: 'integer' },
}, ['slot_id'], async (args, ctx) => {
    return ctx.store.cancelBooking(Number(args.slot_id), ctx.address.channel, ctx.address.handle) ? 'Booking cancelled.' : 'No such booking for this person.';
});

const handoff = tool('handoff_to_human', 'Give this conversation to a human teammate. You will stop replying until they hand it back.', {
    reason: { type: 'string' },
}, ['reason'], async (args, ctx) => {
    const reason = String(args.reason ?? 'asked for a person').slice(0, 300);
    ctx.store.startHandoff(ctx.address.channel, ctx.address.handle, reason);
    await ctx.operator.notifyHandoff(ctx.address, reason, ctx.lastUserText);
    return 'A teammate has been notified. Tell the person a human will reply here soon.';
});

const browseWeb = tool('browse_web', 'Start a web task in a real browser (look something up, fill a public form). It runs in the background and the result is texted to the person when done. It cannot pay, buy, or log in.', {
    goal: { type: 'string', description: 'The task, fully specified, in one or two sentences.' },
    start_url: { type: 'string', description: 'Optional https URL to start from.' },
}, ['goal'], async (args, ctx) => {
    if (!ctx.browse) return 'Error: the browser worker is not configured.';
    if (ctx.store.activeBrowseTasks(ctx.address.channel, ctx.address.handle) > 0) return 'Error: a web task for this person is already running.';
    const goal = String(args.goal ?? '').trim().slice(0, 1000);
    if (!goal) return 'Error: goal is empty.';
    const startUrl = args.start_url ? String(args.start_url) : undefined;
    const id = randomUUID();
    ctx.store.addBrowseTask({ id, channel: ctx.address.channel, handle: ctx.address.handle, goal, status: 'running' });
    try {
        await ctx.browse.start({ id, goal, startUrl, profile: profileName(ctx.address) });
    } catch (error) {
        ctx.store.finishBrowseTask(id, 'failed', (error as Error).message);
        return `Error: could not start the web task (${(error as Error).message}).`;
    }
    return 'Web task started. Tell the person you are on it and will text the result.';
});

// Only offered when text-to-speech is configured (src/agent/voice-note.ts).
const voiceNote = tool('reply_with_voice_note', 'Send your next reply as a spoken voice message instead of text. Use it only when the person asks for a voice message or audio. Keep that reply short and plain, with no links or lists.', {}, [], async (_args, ctx) => {
    if (ctx.address.channel !== 'imessage') return 'Error: voice messages only work over iMessage. Reply in text.';
    if (!ctx.turn) return 'Error: voice messages are not available right now. Reply in text.';
    ctx.turn.voiceNote = true;
    return 'Your next reply will be sent as a voice message. Write it as you would say it.';
});

export function buildTools(options: { browse: boolean; voice?: boolean }): Tool[] {
    const tools = [setReminder, listReminders, cancelReminder, listSlots, bookSlot, myBookings, cancelBooking, handoff];
    if (options.browse) tools.push(browseWeb);
    if (options.voice) tools.push(voiceNote);
    return tools;
}
