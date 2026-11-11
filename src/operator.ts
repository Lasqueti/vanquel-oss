// src/operator.ts
// Human handoff. When the agent calls handoff_to_human, a teammate is told.
//   Slack configured:   a thread opens in SLACK_OPERATOR_CHANNEL. Every new
//                       message from the customer lands in that thread, and
//                       whatever a teammate types there goes to the customer.
//                       Typing "done" in the thread hands it back to the agent.
//   Email configured:   OPERATOR_EMAIL gets a notice; the teammate answers
//                       with POST /admin/reply (see docs/OPERATIONS.md).
//   Neither:            the server log says so; use /admin/reply.

import type { Address, Channel } from './channels/types.ts';
import type { SlackClient } from './channels/slack.ts';
import type { Operator } from './agent/tools.ts';
import type { Store } from './store.ts';
import type { Logger } from './log.ts';
import { tail } from './log.ts';

export interface OperatorDeps {
    store: Store;
    log: Logger;
    slack?: { client: SlackClient; channel: string };
    email?: { channel: Channel; to: string };
}

export const RELEASE_WORDS = new Set(['done', '!done', 'release', '!release']);

export function createOperator(deps: OperatorDeps): Operator {
    const { store, log } = deps;
    return {
        async notifyHandoff(address: Address, reason: string, lastText: string) {
            const who = `${address.channel} ${address.handle}${address.line ? ` (line ${address.line})` : ''}`;
            const notice = `Handoff: ${who}\nReason: ${reason}\nLast message: ${lastText}`;
            if (deps.slack) {
                const ts = await deps.slack.client.postMessage(deps.slack.channel, `${notice}\n\nReply in this thread to answer them. Type "done" to hand the conversation back to the agent.`);
                store.setOperatorThread(address.channel, address.handle, ts);
                return;
            }
            if (deps.email) {
                await deps.email.channel.send({ channel: 'email', handle: deps.email.to, thread: JSON.stringify({ subject: 'Customer handoff', messageId: '' }) }, `${notice}\n\nAnswer with POST /admin/reply, then POST /admin/release to hand back.`);
                return;
            }
            log.warn(`HANDOFF with no operator channel configured: ${address.channel} ${tail(address.handle)}. Answer with POST /admin/reply.`);
        },
        async forward(address: Address, text: string) {
            const contact = store.getContact(address.channel, address.handle);
            if (deps.slack && contact?.operatorThread) {
                await deps.slack.client.postMessage(deps.slack.channel, text, contact.operatorThread);
                return;
            }
            log.info(`message during handoff (${address.channel}); waiting for a teammate`);
        },
    };
}
