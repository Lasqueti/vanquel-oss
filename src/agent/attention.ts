// src/agent/attention.ts
// Whether a message gets an answer at all. Rules carried over from the
// production system this repo comes from:
//
//   Tapbacks are never a turn. Phones and SMS senders deliver a reaction as
//   the sentence Apple writes for it (Loved "see you at 3"). Answered as a
//   message, it got replies like "glad that helped!" and cut into the reply
//   being written. It is kept as context and nothing more.
//
//   In a group chat the agent speaks only when talked to. Answering
//   everything makes it the loudest person in the room. It speaks when a
//   message names it, and when someone answers a question it just asked:
//   the window stays open for GROUP_WINDOW member messages after it spoke,
//   and shuts after GROUP_IDLE_MS (a room that picks up again later is a new
//   conversation). Talking to the whole room ("everyone", "you guys") is not
//   talking to the agent. The model can still choose silence on top of this.
//
//   An SMS, MMS or RCS group means someone in it is not on iMessage. The
//   agent leaves those rooms quietly and never speaks there again.

import type { StoredMessage } from '../store.ts';

export const GROUP_WINDOW = 6;
export const GROUP_IDLE_MS = 30 * 60 * 1000;

const EMOJI = String.raw`(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F]*`;

// Strict on purpose: the WHOLE message must be Apple's sentence, from its
// capitalised verb to the closing quote, so 'Loved "Dune" so much' stays a
// message. Straight and curly quotes both occur.
const TEXT_TAPBACK = new RegExp(
    String.raw`^(?:(?:Liked|Loved|Disliked|Laughed at|Emphasi[sz]ed|Questioned)|Reacted ${EMOJI} to`
        + String.raw`|Removed (?:an? )?(?:heart|like|dislike|laugh|exclamation(?: mark)?|question mark|emphasis|${EMOJI}) from)`
        + String.raw` ["\u201C][\s\S]+["\u201D]$`,
    'u',
);

export function isTextTapback(text: string): boolean {
    return TEXT_TAPBACK.test(text.trim());
}

// The bridge's service field, or the "SMS;-;" style prefix some chat ids carry.
// Nothing known means iMessage: the answer makes the agent leave, so never guess.
export function isSmsGroup(service: string | undefined, chatId: string): boolean {
    if (service && /^(?:sms|mms|rcs)$/i.test(service)) return true;
    return /^(?:sms|mms|rcs);/i.test(chatId);
}

// The agent's name as a whole word, any case, the last letter stretched the
// way people type it ("samm").
export function namesAgent(text: string, agentName: string): boolean {
    const name = agentName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!name) return false;
    return new RegExp(String.raw`(?<![\p{L}\p{N}])${name}+(?![\p{L}\p{N}])`, 'iu').test(text);
}

// messages: the group's recent log, oldest first, the new message last.
export function groupShouldSpeak(messages: StoredMessage[], agentName: string, now: Date): boolean {
    const latest = messages.at(-1);
    if (!latest || latest.direction !== 'in') return false;
    if (namesAgent(latest.text, agentName)) return true;
    const lastOut = messages.findLastIndex((m) => m.direction === 'out');
    if (lastOut === -1) return false;
    const said = messages[lastOut];
    const memberMessages = messages.slice(lastOut + 1).filter((m) => m.direction === 'in').length;
    const fresh = now.getTime() - Date.parse(said.createdAt) < GROUP_IDLE_MS;
    return fresh && memberMessages <= GROUP_WINDOW && /\?\s*$/.test(said.text);
}
