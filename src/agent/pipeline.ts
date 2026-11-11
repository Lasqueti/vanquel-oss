// src/agent/pipeline.ts
// What happens to every inbound message, on every channel:
//   1. dedupe       bridges retry, so the same message id is handled once
//   2. record       the contact and the message go in the store
//   3. opt-out      STOP / START keywords, answered once, before anything else
//   4. handoff      if a human owns the conversation, forward it to them, stop
//   5. rate limit   at most MAX_REPLIES_PER_HOUR replies per person
//   6. debounce     people send three texts in a row; wait a beat, answer once
//   7. respond      model + tools, then send through the channel router
// Replies for one person never overlap: each person has one queue.

import type { Address, InboundMessage } from '../channels/types.ts';
import type { Router } from '../channels/router.ts';
import type { Store } from '../store.ts';
import type { Logger } from '../log.ts';
import { tail } from '../log.ts';
import type { ChatMessage, Llm } from './llm.ts';
import type { BrowseClient, Operator, Tool } from './tools.ts';
import { buildSystemPrompt } from './prompt.ts';

export interface PipelineConfig {
    agentName: string;
    businessName: string;
    businessInfo: string;
    timeZone: string;
    historyLimit: number;
    maxRepliesPerHour: number;
    debounceMs: number;
    maxToolRounds: number;
}

export interface PipelineDeps {
    store: Store;
    router: Router;
    llm: Llm;
    tools: Tool[];
    operator: Operator;
    browse?: BrowseClient;
    log: Logger;
    now?: () => Date;
    config: PipelineConfig;
}

// "cancel" and "end" are left out on purpose: alone, they usually mean
// "cancel my booking". Add them back if your SMS provider requires them.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'resume']);
const FALLBACK_REPLY = 'Sorry, something went wrong on my end. A teammate will follow up.';

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

    function history(address: Address): ChatMessage[] {
        return store.recentMessages(address.channel, address.handle, config.historyLimit).map((m) => ({
            role: m.direction === 'in' ? 'user' : 'assistant',
            content: m.direction === 'operator' ? `[a human teammate wrote] ${m.text}` : m.text,
        }));
    }

    // The model loop: ask, run any tools it calls, ask again, until it answers.
    async function respond(address: Address, lastUserText: string): Promise<string> {
        const messages: ChatMessage[] = [
            { role: 'system', content: buildSystemPrompt({ ...config, channel: address.channel, now: now(), tools: tools.map((t) => t.schema.function.name) }) },
            ...history(address),
        ];
        const byName = new Map(tools.map((t) => [t.schema.function.name, t]));
        for (let round = 0; round <= config.maxToolRounds; round += 1) {
            const reply = await llm.chat(messages, { tools: round < config.maxToolRounds ? tools.map((t) => t.schema) : undefined });
            if (!reply.toolCalls.length) return (reply.content ?? '').trim();
            messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls });
            for (const call of reply.toolCalls) {
                const tool = byName.get(call.function.name);
                let result: string;
                try {
                    const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
                    result = tool ? await tool.run(args, { address, store, now, operator, browse: deps.browse, lastUserText }) : `Error: unknown tool ${call.function.name}`;
                } catch (error) {
                    result = `Error: ${(error as Error).message}`;
                }
                log.info(`tool ${call.function.name} for ${tail(address.handle)}: ${result.split('\n')[0].slice(0, 120)}`);
                messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
        }
        return '';
    }

    async function replyTo(address: Address, lastUserText: string): Promise<void> {
        const contact = store.getContact(address.channel, address.handle);
        // A handoff can start while a reply waited in the debounce.
        if (!contact || contact.optedOut || contact.handoffSince) return;
        let text: string;
        try {
            text = await respond(address, lastUserText);
        } catch (error) {
            log.error(`model failed for ${tail(address.handle)}: ${(error as Error).message}`);
            text = FALLBACK_REPLY;
        }
        if (!text) return;
        try {
            await router.send(address, text);
        } catch (error) {
            log.error(`send failed for ${tail(address.handle)} on ${address.channel}: ${(error as Error).message}`);
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

    async function handleInbound(message: InboundMessage): Promise<'duplicate' | 'opted-out' | 'handed-off' | 'rate-limited' | 'scheduled' | 'keyword' | 'empty'> {
        const { address } = message;
        if (message.externalId && !store.claim(`${address.channel}:${message.externalId}`)) return 'duplicate';
        const contact = store.touchContact(address);
        const text = message.text.trim();
        if (!text) return 'empty';
        store.addMessage(address.channel, address.handle, 'in', text);

        const word = keyword(text);
        if (word === 'stop' && (address.channel === 'imessage' || address.channel === 'sms')) {
            store.setOptOut(address.channel, address.handle, true);
            await router.sendOptOutConfirmation(address, `You're unsubscribed from ${config.businessName} and won't get more messages. Reply START to resume.`)
                .catch((error: Error) => log.warn(`opt-out confirmation failed: ${error.message}`));
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
