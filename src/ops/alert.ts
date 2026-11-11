// src/ops/alert.ts
// Operator alerts (a line is down, a reminder could not be sent). They go to
// a Slack incoming webhook, never through the iMessage lines: a line that is
// down cannot announce its own outage.

export function createAlerter(webhookUrl: string, log: (message: string) => void, fetchImpl: typeof fetch = fetch) {
    return async function alert(text: string): Promise<void> {
        log(`ALERT ${text}`);
        if (!webhookUrl) return;
        try {
            const response = await fetchImpl(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) log(`alert webhook answered ${response.status}`);
        } catch (error) {
            log(`alert webhook failed: ${(error as Error).message}`);
        }
    };
}

export type Alert = ReturnType<typeof createAlerter>;
