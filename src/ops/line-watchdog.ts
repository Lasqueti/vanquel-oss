// src/ops/line-watchdog.ts
// Probes every iMessage line's bridge /health once a minute and alerts after
// MISSES_BEFORE_ALERT misses in a row, then again when it recovers.
//
// ALERT ONLY. It never touches a phone. The production system this comes
// from had an auto-healing watchdog, and its worst outage was the watchdog
// healing a phone at the same moment a person was working on it: two
// userspace reboots seconds apart pushed the phone into a full reboot, which
// drops a semi-tethered jailbreak. Recovery is a deliberate human step; see
// docs/PHONES.md, "When a line goes down". Run: npm run watchdog

import { resolve } from 'node:path';
import { envInt, envMap, env, loadEnvFile } from '../config.ts';
import { createLogger } from '../log.ts';
import { createAlerter } from './alert.ts';

export const MISSES_BEFORE_ALERT = 3;

export interface LineStatus {
    misses: number;
    alerted: boolean;
}

// Pure: what changed for one line after one probe.
export function nextStatus(status: LineStatus, healthy: boolean): { status: LineStatus; event: 'down' | 'recovered' | null } {
    if (healthy) return { status: { misses: 0, alerted: false }, event: status.alerted ? 'recovered' : null };
    const misses = status.misses + 1;
    if (misses >= MISSES_BEFORE_ALERT && !status.alerted) return { status: { misses, alerted: true }, event: 'down' };
    return { status: { misses, alerted: status.alerted }, event: null };
}

async function probe(url: string): Promise<{ healthy: boolean; detail: string }> {
    try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
        const body = (await response.json().catch(() => ({}))) as { status?: string; phone?: string; lastError?: string };
        return { healthy: response.ok && body.status === 'ok', detail: body.lastError || (body.phone === 'down' ? 'phone not answering' : `HTTP ${response.status}`) };
    } catch (error) {
        return { healthy: false, detail: `bridge not answering (${(error as Error).message})` };
    }
}

// Runs only when started directly, so tests can import nextStatus.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    loadEnvFile();
    const log = createLogger('watchdog');
    const alert = createAlerter(env('ALERT_SLACK_WEBHOOK_URL'), (m) => log.warn(m));
    const lines = envMap('IMESSAGE_LINES');
    const statuses = new Map<string, LineStatus>();
    const tick = async () => {
        for (const [line, url] of Object.entries(lines)) {
            const result = await probe(url);
            const { status, event } = nextStatus(statuses.get(line) ?? { misses: 0, alerted: false }, result.healthy);
            statuses.set(line, status);
            if (event === 'down') await alert(`iMessage line ${line} is DOWN: ${result.detail}. See docs/PHONES.md, "When a line goes down".`);
            if (event === 'recovered') await alert(`iMessage line ${line} recovered.`);
        }
    };
    log.info(`watching ${Object.keys(lines).length} line(s)`);
    void tick();
    setInterval(() => void tick(), envInt('WATCHDOG_INTERVAL_MS', 60_000));
}
