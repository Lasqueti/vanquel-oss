// src/reminders.ts
// Sends reminders when they come due. A failed send is retried on the next
// tick, up to MAX_ATTEMPTS, then the operator is alerted. A reminder is
// marked sent only after the channel accepted it.

import type { Router } from './channels/router.ts';
import type { Store } from './store.ts';
import type { Alert } from './ops/alert.ts';

export const MAX_ATTEMPTS = 3;

export function createReminderRunner(store: Store, router: Router, alert: Alert) {
    let running = false;
    async function tick(): Promise<number> {
        if (running) return 0;
        running = true;
        let sent = 0;
        try {
            for (const reminder of store.dueReminders(MAX_ATTEMPTS)) {
                try {
                    await router.send({ channel: reminder.channel, handle: reminder.handle }, reminder.text);
                    store.markReminderSent(reminder.id);
                    sent += 1;
                } catch (error) {
                    store.markReminderFailed(reminder.id);
                    if (reminder.attempts + 1 >= MAX_ATTEMPTS) await alert(`Reminder ${reminder.id} on ${reminder.channel} failed ${MAX_ATTEMPTS} times: ${(error as Error).message}`);
                }
            }
        } finally {
            running = false;
        }
        return sent;
    }
    return { tick, start: (everyMs: number) => setInterval(() => void tick(), everyMs) };
}
