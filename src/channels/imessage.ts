// src/channels/imessage.ts
// iMessage goes out through a bridge, one per line. A line is either the Mac
// mini's own Messages account (bridges/mac) or a jailbroken iPhone running
// SMServer (bridges/phone). Both bridges speak the same contract:
//   POST /send   {to, text}  header X-Bridge-Key   -> 200 {ok, verified?}
//   GET  /health                                   -> 200 {status}
// IMESSAGE_LINES maps line ids to bridge URLs. A reply goes out the line the
// person last texted; a person with no line uses IMESSAGE_DEFAULT_LINE.
// SMS threads on an iPhone line get SMS replies: the phone answers on the
// thread's own service.

import type { Address, Channel } from './types.ts';

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
    isGroup?: boolean;
}

export function createIMessageChannel(config: IMessageConfig): Channel {
    const fetchImpl = config.fetchImpl ?? fetch;
    return {
        id: 'imessage',
        style: 'bubbles',
        async send(address: Address, text: string) {
            const line = address.line && config.lines[address.line] ? address.line : config.defaultLine;
            const url = config.lines[line];
            if (!url) throw new Error(`no bridge URL for line "${line}"`);
            const response = await fetchImpl(`${url}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': config.bridgeKey },
                body: JSON.stringify({ to: address.handle, text }),
                signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
            });
            if (!response.ok) throw new Error(`bridge ${line} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
        },
    };
}

export function parseInboundIMessage(body: Record<string, unknown>): InboundIMessage | null {
    const line = String(body.line ?? '').trim();
    const from = String(body.from ?? '').trim();
    const text = String(body.text ?? '').trim();
    const guid = String(body.guid ?? '').trim();
    if (!line || !from || !guid) return null;
    return { line, from, text, guid, isGroup: body.isGroup === true };
}
