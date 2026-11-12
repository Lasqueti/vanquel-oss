// src/channels/imessage.ts
// iMessage goes out through a bridge, one per line. A line is either the Mac
// mini's own Messages account (bridges/mac) or a jailbroken iPhone running
// SMServer (bridges/phone). Both bridges speak the same contract, header
// X-Bridge-Key on every call:
//   POST /send     {to, text?, files?, audio?}   -> 200 {ok, verified?}
//   POST /typing   {to}                          best effort
//   GET  /health                                 -> 200 {status}
// `to` is a person's handle or a group chat id; files are absolute paths on
// this machine. IMESSAGE_LINES maps line ids to bridge URLs. A reply goes out
// the line the person last texted; a person with no line uses
// IMESSAGE_DEFAULT_LINE. SMS threads on an iPhone line get SMS replies: the
// phone answers on the thread's own service.

import type { Address, Attachment, Channel } from './types.ts';

export interface IMessageConfig {
    lines: Record<string, string>;
    defaultLine: string;
    bridgeKey: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export interface InboundIMessage {
    line: string;
    from: string;
    text: string;
    guid: string;
    isGroup: boolean;
    // The group chat id. Set only for a group the server can route back to.
    chat?: string;
    service?: string;
    replyTo?: string;
    attachments: Attachment[];
}

const MAX_ATTACHMENTS = 10;
const TYPING_TIMEOUT_MS = 5_000;

export function createIMessageChannel(config: IMessageConfig): Channel {
    const fetchImpl = config.fetchImpl ?? fetch;

    async function post(address: Address, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
        const line = address.line && config.lines[address.line] ? address.line : config.defaultLine;
        const url = config.lines[line];
        if (!url) throw new Error(`no bridge URL for line "${line}"`);
        const response = await fetchImpl(`${url}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': config.bridgeKey },
            body: JSON.stringify({ to: address.handle, ...body }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`bridge ${line} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    return {
        id: 'imessage',
        style: 'bubbles',
        send: (address, text) => post(address, '/send', { text }, config.timeoutMs ?? 60_000),
        sendFiles: (address, files, options = {}) => post(address, '/send', { files, ...(options.audio ? { audio: true } : {}) }, config.timeoutMs ?? 60_000),
        typing: (address) => post(address, '/typing', {}, TYPING_TIMEOUT_MS),
    };
}

function parseAttachments(value: unknown): Attachment[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object' && typeof (a as Record<string, unknown>).url === 'string')
        .slice(0, MAX_ATTACHMENTS)
        .map((a) => ({ url: String(a.url), mimeType: String(a.mimeType ?? '').toLowerCase().slice(0, 100), fileName: String(a.fileName ?? '').slice(0, 200) }));
}

export function parseInboundIMessage(body: Record<string, unknown>): InboundIMessage | null {
    const line = String(body.line ?? '').trim();
    const from = String(body.from ?? '').trim();
    const text = String(body.text ?? '').trim();
    const guid = String(body.guid ?? '').trim();
    if (!line || !from || !guid) return null;
    const chat = String(body.chat ?? '').trim();
    const isGroup = body.isGroup === true;
    const service = typeof body.service === 'string' && body.service.trim() ? body.service.trim() : undefined;
    // The bridges send {guid, text, isFromMe}; a plain string is accepted too.
    const replyRaw = body.replyTo && typeof body.replyTo === 'object' ? (body.replyTo as Record<string, unknown>).text : body.replyTo;
    const replyTo = typeof replyRaw === 'string' && replyRaw.trim() ? replyRaw.trim() : undefined;
    // A group id that equals the sender's own handle is not a group: routing
    // to it would be a DM, so it is dropped like a group with no id.
    const routable = isGroup && chat && chat !== from;
    return { line, from, text, guid, isGroup, ...(routable ? { chat } : {}), service, replyTo, attachments: parseAttachments(body.attachments) };
}
