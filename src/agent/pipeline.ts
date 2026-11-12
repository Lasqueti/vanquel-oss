// src/agent/pipeline.ts
// What happens to every inbound message, on every channel:
//   1. dedupe       bridges retry, so the same message id is handled once
//   2. record       the contact and the message go in the store. An SMS
//                   group chat is left before anything is recorded; a tapback
//                   is recorded as context and stops here (src/agent/attention.ts)
//   3. opt-out      STOP / START keywords, answered once, before anything else
//   4. handoff      if a human owns the conversation, forward it to them, stop
//   5. rate limit   at most MAX_REPLIES_PER_HOUR replies per conversation
//   6. attention    in a group chat, answer only when talked to
//   7. debounce     people send three texts in a row; wait a beat, answer once
//   8. respond      typing bubble, model + tools, then send through the router;
//                   a picture card (send_card) follows the words
// Replies for one conversation never overlap: each has one queue. A group
// chat is one conversation, so four people typing at once get one answer.
//
// Group chats see only their own history, get no tools (nothing can act on a
// member's account from a room everyone reads), and may stay silent.

import type { Address, InboundMessage } from '../channels/types.ts';
import type { Router } from '../channels/router.ts';
import type { Store } from '../store.ts';
import type { Logger } from '../log.ts';
import { tail } from '../log.ts';
import type { ChatMessage, ContentPart, Llm } from './llm.ts';
import type { BrowseClient, Operator, Tool, ToolContext } from './tools.ts';
import { NO_REPLY, buildSystemPrompt } from './prompt.ts';
import { GROUP_WINDOW, groupShouldSpeak, isSmsGroup, isTextTapback } from './attention.ts';
import type { ImageLoader } from './media.ts';
import { describeAttachment, isImage } from './media.ts';
import type { VoiceNotes } from './voice-note.ts';
import { isVoiceable } from './voice-note.ts';
import type { CardRenderer } from '../cards/render.ts';
import { captionFor } from '../cards/cards.ts';

export interface PipelineConfig {
    agentName: string;
    businessName: string;
    businessInfo: string;
    timeZone: string;
    historyLimit: number;
    maxRepliesPerHour: number;
    debounceMs: number;
    maxToolRounds: number;
    // SEND_CONTACT_CARD: the .vcf sent after the first reply to a new person.
    contactCardPath?: string;
}

export interface PipelineDeps {
    store: Store;
    router: Router;
    llm: Llm;
    tools: Tool[];
    operator: Operator;
    browse?: BrowseClient;
    // LLM_VISION: photos reach the model as images. Without it, a "[photo]" note.
    loadImage?: ImageLoader;
    voiceNotes?: VoiceNotes;
    // CARDS=1: picture cards the model sends with send_card.
    cards?: CardRenderer;
    log: Logger;
    now?: () => Date;
    config: PipelineConfig;
}

export type InboundResult = 'duplicate' | 'opted-out' | 'handed-off' | 'rate-limited' | 'scheduled' | 'keyword' | 'empty' | 'reaction' | 'quiet' | 'left-group';

// "cancel" and "end" are left out on purpose: alone, they usually mean
// "cancel my booking". Add them back if your SMS provider requires them.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'resume']);
const FALLBACK_REPLY = 'Sorry, something went wrong on my end. A teammate will follow up.';
const MAX_IMAGES_PER_TURN = 4;

export function keyword(text: string): 'stop' | 'start' | null {
    const word = text.trim().toLowerCase().replace(/[.!]+$/, '');
    if (STOP_WORDS.has(word)) return 'stop';
    if (START_WORDS.has(word)) return 'start';
    return null;
}

export function createPipeline(deps: PipelineDeps) {
    const { store, router, llm, tools, operator, log, config } = deps;
    const now = deps.now ?? (() => new Date());
    const queues = new Map<string, Promise<void>>();
    const pending = new Map<string, NodeJS.Timeout>();
    const inFlight = new Set<Promise<void>>();

    const keyOf = (address: Address) => `${address.channel}:${address.handle}`;

    // The stored conversation as model messages. Group members are labelled
    // by the last four characters of their handle, never the full number.
    // Photos in messages not yet answered are attached as images when vision
    // is on; everything else is a short note.
    async function history(address: Address, group: boolean): Promise<ChatMessage[]> {
        const rows = store.recentMessages(address.channel, address.handle, config.historyLimit);
        const unanswered = rows.findLastIndex((m) => m.direction !== 'in') + 1;
        const out: ChatMessage[] = [];
        let imageCount = 0;
        for (const [index, m] of rows.entries()) {
            if (m.direction !== 'in') {
                out.push({ role: 'assistant', content: m.direction === 'operator' ? `[a human teammate wrote] ${m.text}` : m.text });
                continue;
            }
            const vision = deps.loadImage && index >= unanswered ? deps.loadImage : null;
            const images: ContentPart[] = [];
            const notes: string[] = [];
            for (const attachment of m.attachments) {
                const url = vision && isImage(attachment) && imageCount < MAX_IMAGES_PER_TURN ? await vision(attachment) : null;
                if (url) {
                    imageCount += 1;
                    images.push({ type: 'image_url', image_url: { url } });
                }
                notes.push(vision && isImage(attachment) && !url ? '[photo: could not be opened]' : describeAttachment(attachment));
            }
            const label = group ? `${m.sender ? tail(m.sender) : 'someone'}: ` : '';
            const text = label + [m.text, ...notes].filter(Boolean).join('\n');
            out.push({ role: 'user', content: images.length ? [{ type: 'text', text }, ...images] : text });
        }
        return out;
    }

    // The model loop: ask, run any tools it calls, ask again, until it answers.
    async function respond(address: Address, group: boolean, lastUserText: string, turn: ToolContext['turn']): Promise<string> {
        const available = group ? [] : tools;
        const messages: ChatMessage[] = [
            { role: 'system', content: buildSystemPrompt({ ...config, channel: address.channel, now: now(), tools: available.map((t) => t.schema.function.name), group }) },
            ...(await history(address, group)),
        ];
        const byName = new Map(available.map((t) => [t.schema.function.name, t]));
        for (let round = 0; round <= config.maxToolRounds; round += 1) {
            const offer = round < config.maxToolRounds && available.length ? available.map((t) => t.schema) : undefined;
            const reply = await llm.chat(messages, { tools: offer });
            if (!reply.toolCalls.length) return (reply.content ?? '').trim();
            messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls });
            for (const call of reply.toolCalls) {
                const tool = byName.get(call.function.name);
                let result: string;
                try {
                    const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
                    result = tool ? await tool.run(args, { address, store, now, operator, browse: deps.browse, lastUserText, turn }) : `Error: unknown tool ${call.function.name}`;
                } catch (error) {
                    result = `Error: ${(error as Error).message}`;
                }
                log.info(`tool ${call.function.name} for ${tail(address.handle)}: ${result.split('\n')[0].slice(0, 120)}`);
                messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
        }
        return '';
    }

    // A voice note when the model asked for one and the words suit being
    // heard. False means "send it as text instead".
    async function sentAsVoiceNote(address: Address, text: string): Promise<boolean> {
        if (!deps.voiceNotes || !isVoiceable(text)) return false;
        try {
            const path = await deps.voiceNotes.synthesize(text);
            await router.sendFile(address, path, `[voice note] ${text}`, { audio: true });
            return true;
        } catch (error) {
            log.warn(`voice note failed for ${tail(address.handle)}, sending text: ${(error as Error).message}`);
            return false;
        }
    }

    async function replyTo(address: Address, lastUserText: string): Promise<void> {
        const contact = store.getContact(address.channel, address.handle);
        // A handoff can start while a reply waited in the debounce.
        if (!contact || contact.optedOut || contact.handoffSince || contact.leftReason) return;
        void router.typing(address);
        const turn: NonNullable<ToolContext['turn']> = { voiceNote: false };
        let text: string;
        try {
            text = await respond(address, contact.isGroup, lastUserText, turn);
        } catch (error) {
            log.error(`model failed for ${tail(address.handle)}: ${(error as Error).message}`);
            // Silence is a normal outcome in a group; an apology to the room is not.
            text = contact.isGroup ? '' : FALLBACK_REPLY;
        }
        if (!text || (contact.isGroup && text.includes(NO_REPLY))) return;
        const firstReply = Boolean(config.contactCardPath) && !contact.isGroup && address.channel === 'imessage'
            && store.outboundSince(address.channel, address.handle, new Date(0).toISOString()) === 0;
        try {
            if (!(turn.voiceNote && (await sentAsVoiceNote(address, text)))) await router.send(address, text);
        } catch (error) {
            log.error(`send failed for ${tail(address.handle)} on ${address.channel}: ${(error as Error).message}`);
            return;
        }
        // A card the model asked for (send_card) follows the words. If it
        // cannot be drawn or sent, the words already went, so nothing is lost.
        if (turn.card && deps.cards) {
            try {
                await router.sendFile(address, await deps.cards.render(turn.card), `[card: ${captionFor(turn.card)}]`);
            } catch (error) {
                log.warn(`card failed for ${tail(address.handle)}: ${(error as Error).message}`);
            }
        }
        if (firstReply && store.claim(`contact-card:${address.channel}:${address.handle}`)) {
            await router.sendFile(address, config.contactCardPath!, '[sent our contact card]')
                .catch((error: Error) => log.warn(`contact card failed for ${tail(address.handle)}: ${error.message}`));
        }
    }

    function schedule(address: Address, lastUserText: string): void {
        const key = keyOf(address);
        clearTimeout(pending.get(key));
        const run = () => {
            pending.delete(key);
            const previous = queues.get(key) ?? Promise.resolve();
            const next = previous.then(() => replyTo(address, lastUserText));
            queues.set(key, next);
            inFlight.add(next);
            void next.finally(() => {
                inFlight.delete(next);
                if (queues.get(key) === next) queues.delete(key);
            });
        };
        if (config.debounceMs <= 0) run();
        else pending.set(key, setTimeout(run, config.debounceMs));
    }

    async function handleInbound(message: InboundMessage): Promise<InboundResult> {
        const { address } = message;
        if (message.externalId && !store.claim(`${address.channel}:${message.externalId}`)) return 'duplicate';
        const contact = store.touchContact(address);
        if (contact.isGroup && (contact.leftReason || isSmsGroup(message.service, address.handle))) {
            if (!contact.leftReason) {
                store.leaveGroup(address.channel, address.handle, 'sms');
                log.info(`left group ${tail(address.handle)}: it is an SMS group, not iMessage`);
            }
            return 'left-group';
        }
        const text = message.text.trim();
        const attachments = message.attachments ?? [];
        const extra = { sender: message.sender, attachments };
        if (isTextTapback(text) && !attachments.length) {
            store.addMessage(address.channel, address.handle, 'in', `(tapback) ${text}`, extra);
            return 'reaction';
        }
        if (!text && !attachments.length) return 'empty';
        store.addMessage(address.channel, address.handle, 'in', text, extra);

        const word = keyword(text);
        if (word === 'stop' && (address.channel === 'imessage' || address.channel === 'sms')) {
            store.setOptOut(address.channel, address.handle, true);
            const confirmation = contact.isGroup
                ? `Okay, I'll stay out of this chat. Reply START to bring me back.`
                : `You're unsubscribed from ${config.businessName} and won't get more messages. Reply START to resume.`;
            await router.sendOptOutConfirmation(address, confirmation).catch((error: Error) => log.warn(`opt-out confirmation failed: ${error.message}`));
            return 'keyword';
        }
        if (word === 'start' && contact.optedOut) {
            store.setOptOut(address.channel, address.handle, false);
            await router.send(address, `You're resubscribed. How can I help?`).catch((error: Error) => log.warn(`resubscribe reply failed: ${error.message}`));
            return 'keyword';
        }
        if (contact.optedOut) return 'opted-out';

        if (contact.handoffSince) {
            await operator.forward(address, text).catch((error: Error) => log.error(`operator forward failed: ${error.message}`));
            return 'handed-off';
        }

        const hourAgo = new Date(now().getTime() - 3600_000).toISOString();
        if (store.outboundSince(address.channel, address.handle, hourAgo) >= config.maxRepliesPerHour) {
            log.warn(`rate limit reached for ${tail(address.handle)}; not replying`);
            return 'rate-limited';
        }

        if (contact.isGroup) {
            // A member who opted out of their own conversation with us does not
            // wake the agent anywhere.
            const senderOptedOut = message.sender ? store.getContact(address.channel, message.sender)?.optedOut : false;
            const recent = store.recentMessages(address.channel, address.handle, GROUP_WINDOW + 6);
            if (senderOptedOut || !groupShouldSpeak(recent, config.agentName, now())) return 'quiet';
        }

        schedule(address, text);
        return 'scheduled';
    }

    return {
        handleInbound,
        // Resolves once every scheduled reply has finished (tests, shutdown).
        async idle(): Promise<void> {
            while (pending.size || inFlight.size) {
                await new Promise((resolve) => setTimeout(resolve, Math.max(config.debounceMs, 5)));
                await Promise.all([...inFlight]);
            }
        },
    };
}

export type Pipeline = ReturnType<typeof createPipeline>;
