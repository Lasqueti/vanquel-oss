// tests/helpers.ts
// Fakes shared by the tests: a scripted model, a channel that records sends,
// files and typing, and a quiet logger. Phone numbers in tests use the
// fictional 555-01xx range.

import type { ChatMessage, Llm, LlmReply, ToolCall } from '../src/agent/llm.ts';
import type { Address, Channel, ChannelId } from '../src/channels/types.ts';
import type { Logger } from '../src/log.ts';

export const PERSON = '+15550100123';
export const OTHER = '+15550100199';
export const THIRD = '+15550100177';
export const GROUP = 'iMessage;+;chat100001';

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

export interface RecordingChannel extends Channel {
    sent: Array<{ address: Address; text: string }>;
    files: Array<{ address: Address; files: string[]; audio: boolean }>;
    typed: Address[];
}

export function recordingChannel(id: ChannelId = 'imessage', style: Channel['style'] = 'bubbles'): RecordingChannel {
    const sent: RecordingChannel['sent'] = [];
    const files: RecordingChannel['files'] = [];
    const typed: Address[] = [];
    return {
        id,
        style,
        sent,
        files,
        typed,
        async send(address, text) {
            sent.push({ address, text });
        },
        async sendFiles(address, paths, options = {}) {
            files.push({ address, files: paths, audio: Boolean(options.audio) });
        },
        async typing(address) {
            typed.push(address);
        },
    };
}

// The text of a model message, whether plain or a list of parts.
export function textOf(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content;
    return (content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
}

export const quietLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };
