// src/channels/router.ts
// The only way anything in the server sends a message to a person. It holds
// the anti-spam rules in one place, so no feature can skip them:
//   1. Only people who messaged us first can be messaged. There is no way to
//      start a conversation with a stranger.
//   2. Anyone who opted out (STOP) gets nothing, except the one opt-out reply.
//   3. Text channels split a reply into at most MAX_BUBBLES short bubbles.

import type { Address, Channel, ChannelId } from './types.ts';
import type { Store } from '../store.ts';

const MAX_BUBBLES = 4;

export class SendRefused extends Error {}

export function splitBubbles(text: string): string[] {
    const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    if (parts.length <= MAX_BUBBLES) return parts;
    return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join('\n\n')];
}

export function createRouter(store: Store, channels: Channel[]) {
    const byId = new Map<ChannelId, Channel>(channels.map((channel) => [channel.id, channel]));

    async function deliver(address: Address, text: string, options: { ignoreOptOut?: boolean; direction?: 'out' | 'operator' } = {}): Promise<void> {
        const channel = byId.get(address.channel);
        if (!channel) throw new SendRefused(`channel ${address.channel} is not configured`);
        const contact = store.getContact(address.channel, address.handle);
        if (!contact) throw new SendRefused('this person has never messaged us; refusing to start a conversation');
        if (contact.optedOut && !options.ignoreOptOut) throw new SendRefused('this person opted out');
        const target: Address = { ...address, line: address.line ?? contact.line ?? undefined, thread: address.thread ?? contact.thread ?? undefined };
        const pieces = channel.style === 'bubbles' ? splitBubbles(text) : [text.trim()];
        for (const piece of pieces) {
            await channel.send(target, piece);
            store.addMessage(address.channel, address.handle, options.direction ?? 'out', piece);
        }
    }

    return {
        has: (id: ChannelId) => byId.has(id),
        send: (address: Address, text: string) => deliver(address, text),
        // A human teammate's words, logged as theirs so the agent knows who said it.
        sendAsOperator: (address: Address, text: string) => deliver(address, text, { direction: 'operator' }),
        sendOptOutConfirmation: (address: Address, text: string) => deliver(address, text, { ignoreOptOut: true }),
    };
}

export type Router = ReturnType<typeof createRouter>;
