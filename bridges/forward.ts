// bridges/forward.ts
// Hands one inbound text to the agent server. Shared by both bridges.
//   'ok'      the server took it (or already had it: it dedupes by guid)
//   'refused' the server will never take it (4xx other than 401/408/429): skip it
//   'retry'   nothing listening, a 5xx, a timeout, or a bad key: keep it, try later

export type ForwardResult = 'ok' | 'refused' | 'retry';

export interface InboundPayload {
    line: string;
    from: string;
    text: string;
    guid: string;
    isGroup: boolean;
    service?: string;
}

export function createForwarder(serverUrl: string, bridgeKey: string, fetchImpl: typeof fetch = fetch) {
    return async function forward(payload: InboundPayload): Promise<ForwardResult> {
        try {
            const response = await fetchImpl(`${serverUrl}/inbound/imessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': bridgeKey },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000),
            });
            if (response.ok) return 'ok';
            if (response.status >= 400 && response.status < 500 && ![401, 408, 429].includes(response.status)) return 'refused';
            return 'retry';
        } catch {
            return 'retry';
        }
    };
}

export type Forwarder = ReturnType<typeof createForwarder>;
