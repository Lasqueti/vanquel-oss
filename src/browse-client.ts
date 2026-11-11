// src/browse-client.ts
// How the server starts a task on the browser worker (worker/). The worker
// answers at once and calls back POST /internal/browse-result when done.

import type { BrowseClient } from './agent/tools.ts';

export function createBrowseClient(workerUrl: string, secret: string, callbackUrl: string, fetchImpl: typeof fetch = fetch): BrowseClient {
    return {
        async start(task) {
            const response = await fetchImpl(`${workerUrl}/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': secret },
                body: JSON.stringify({ ...task, callbackUrl }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error(`worker answered ${response.status}`);
        },
    };
}
