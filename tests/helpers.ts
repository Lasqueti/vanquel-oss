// tests/helpers.ts
// Fakes shared by the tests: a scripted model, a channel that records sends,
// and a quiet logger. Phone numbers in tests use the fictional 555-01xx range.

import type { ChatMessage, Llm, LlmReply, ToolCall } from '../src/agent/llm.ts';
import type { Address, Channel, ChannelId } from '../src/channels/types.ts';
import type { Logger } from '../src/log.ts';

export const PERSON = '+15550100123';
export const OTHER = '+15550100199';

export function scriptedLlm(replies: Array<LlmReply | ((messages: ChatMessage[]) => LlmReply)>): Llm & { calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    return {
        calls,
        async chat(messages) {
            calls.push(messages);
            const next = replies.shift();
            if (!next) return { content: 'ok', toolCalls: [] };
            return typeof next === 'function' ? next(messages) : next;
        },
    };
}

export function say(content: string): LlmReply {
    return { content, toolCalls: [] };
}

let callId = 0;
export function callTool(name: string, args: Record<string, unknown>): LlmReply {
    callId += 1;
    const call: ToolCall = { id: `call_${callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    return { content: null, toolCalls: [call] };
}

export function recordingChannel(id: ChannelId = 'imessage', style: Channel['style'] = 'bubbles'): Channel & { sent: Array<{ address: Address; text: string }> } {
    const sent: Array<{ address: Address; text: string }> = [];
    return {
        id,
        style,
        sent,
        async send(address, text) {
            sent.push({ address, text });
        },
    };
}

export const quietLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };
