// src/app.ts
// Every HTTP route of the agent server, built from its dependencies so tests
// can drive it without a network. src/server.ts wires real dependencies.
//
//   GET  /health
//   POST /inbound/imessage          from the bridges          X-Bridge-Key
//   POST /channels/sms/twilio       from Twilio               X-Twilio-Signature
//   POST /channels/email/postmark   from Postmark             ?token=
//   POST /channels/slack/events     from Slack                X-Slack-Signature
//   POST /internal/browse-result    from the browser worker   X-Worker-Secret, loopback only
//   POST /admin/reply | /admin/release | /admin/slots, GET /admin/slots    Bearer ADMIN_TOKEN

import type { Handler, Req } from './http.ts';
import { HttpError, header, isLoopback, json, parseForm, parseJson, safeEqual } from './http.ts';
import type { ChannelId } from './channels/types.ts';
import type { Router } from './channels/router.ts';
import type { SlackClient } from './channels/slack.ts';
import { parseSlackEvent, verifySlackRequest } from './channels/slack.ts';
import { parseTwilioInbound, verifyTwilioSignature } from './channels/sms-twilio.ts';
import { parsePostmarkInbound } from './channels/email-postmark.ts';
import { parseInboundIMessage } from './channels/imessage.ts';
import type { Pipeline } from './agent/pipeline.ts';
import type { Store } from './store.ts';
import type { Logger } from './log.ts';
import { RELEASE_WORDS } from './operator.ts';
import type { CardRenderer } from './cards/render.ts';
import { captionFor, resultCard } from './cards/cards.ts';

export interface AppConfig {
    bridgeKey: string;
    adminToken: string;
    publicBaseUrl: string;
    twilioAuthToken?: string;
    emailInboundToken?: string;
    slack?: { signingSecret: string; operatorChannel: string; client: SlackClient };
    workerSecret?: string;
}

export interface AppDeps {
    store: Store;
    pipeline: Pipeline;
    router: Router;
    log: Logger;
    // CARDS=1: a web task that found a list also sends it as a picture card.
    cards?: CardRenderer;
    config: AppConfig;
}

const CHANNELS: ChannelId[] = ['imessage', 'sms', 'email', 'slack'];

export function createRoutes(deps: AppDeps): Record<string, Handler> {
    const { store, pipeline, router, log, config } = deps;

    function requireAdmin(req: Req): void {
        if (!config.adminToken) throw new HttpError(403, 'admin API is off: set ADMIN_TOKEN');
        if (!safeEqual(header(req, 'authorization'), `Bearer ${config.adminToken}`)) throw new HttpError(401, 'bad admin token');
    }

    function addressFrom(body: Record<string, unknown>) {
        const channel = String(body.channel ?? '') as ChannelId;
        const handle = String(body.handle ?? '').trim();
        if (!CHANNELS.includes(channel) || !handle) throw new HttpError(400, 'channel and handle are required');
        if (!store.getContact(channel, handle)) throw new HttpError(404, 'no such contact');
        return { channel, handle };
    }

    return {
        'GET /health': () => json(200, { status: 'ok' }),

        'POST /inbound/imessage': async (req) => {
            if (!config.bridgeKey || !safeEqual(header(req, 'x-bridge-key'), config.bridgeKey)) throw new HttpError(401, 'bad bridge key');
            const message = parseInboundIMessage(parseJson(req));
            if (!message) throw new HttpError(400, 'line, from and guid are required');
            // A group with no usable chat id cannot be answered in the group, and
            // answering the sender privately would leak the room into a DM.
            if (message.isGroup && !message.chat) return json(200, { result: 'ignored-group' });
            // A group is its own conversation, keyed by the chat id; the member who
            // wrote is kept per message.
            const address = message.chat
                ? { channel: 'imessage' as const, handle: message.chat, line: message.line, group: true }
                : { channel: 'imessage' as const, handle: message.from, line: message.line };
            const result = await pipeline.handleInbound({
                address,
                // An inline reply (long-press, Reply) says which bubble it answers.
                text: message.replyTo && message.text ? `[replying to: "${message.replyTo.slice(0, 300)}"] ${message.text}` : message.text,
                externalId: message.guid,
                sender: message.chat ? message.from : undefined,
                attachments: message.attachments,
                service: message.service,
            });
            return json(200, { result });
        },

        'POST /channels/sms/twilio': async (req) => {
            if (!config.twilioAuthToken) throw new HttpError(404, 'SMS is not configured');
            const params = parseForm(req);
            const fullUrl = `${config.publicBaseUrl}${req.url}`;
            if (!verifyTwilioSignature(config.twilioAuthToken, fullUrl, params, header(req, 'x-twilio-signature'))) throw new HttpError(403, 'bad signature');
            const sms = parseTwilioInbound(params);
            if (sms) await pipeline.handleInbound({ address: { channel: 'sms', handle: sms.from }, text: sms.text, externalId: sms.id });
            return { status: 200, body: '<Response></Response>', headers: { 'Content-Type': 'text/xml' } };
        },

        'POST /channels/email/postmark': async (req) => {
            if (!config.emailInboundToken) throw new HttpError(404, 'email is not configured');
            if (!safeEqual(req.query.get('token') ?? '', config.emailInboundToken)) throw new HttpError(403, 'bad token');
            const mail = parsePostmarkInbound(parseJson(req));
            if (!mail) throw new HttpError(400, 'not an inbound email');
            const result = await pipeline.handleInbound({ address: { channel: 'email', handle: mail.from, thread: JSON.stringify(mail.thread) }, text: mail.text, externalId: mail.id });
            return json(200, { result });
        },

        'POST /channels/slack/events': async (req) => {
            const slack = config.slack;
            if (!slack) throw new HttpError(404, 'Slack is not configured');
            const raw = req.rawBody.toString('utf8');
            if (!verifySlackRequest(slack.signingSecret, header(req, 'x-slack-request-timestamp'), raw, header(req, 'x-slack-signature'))) throw new HttpError(403, 'bad signature');
            const event = parseSlackEvent(parseJson(req), slack.operatorChannel);
            if (event.kind === 'challenge') return { status: 200, body: event.challenge };
            if (event.kind === 'dm') {
                await pipeline.handleInbound({ address: { channel: 'slack', handle: event.channel }, text: event.text, externalId: event.eventId });
            } else if (event.kind === 'thread-reply') {
                if (!store.claim(`slack-op:${event.eventId}`)) return json(200, { ok: true });
                const contact = store.findByOperatorThread(event.threadTs);
                if (!contact) return json(200, { ok: true });
                const address = { channel: contact.channel, handle: contact.handle };
                if (RELEASE_WORDS.has(event.text.toLowerCase())) {
                    store.endHandoff(contact.channel, contact.handle);
                    await slack.client.postMessage(slack.operatorChannel, 'Handed back to the agent.', event.threadTs);
                } else if (event.text) {
                    await router.sendAsOperator(address, event.text).catch(async (error: Error) => {
                        await slack.client.postMessage(slack.operatorChannel, `Could not deliver: ${error.message}`, event.threadTs);
                    });
                }
            }
            return json(200, { ok: true });
        },

        'POST /internal/browse-result': async (req) => {
            if (!config.workerSecret || !isLoopback(req.remoteAddress) || !safeEqual(header(req, 'x-worker-secret'), config.workerSecret)) throw new HttpError(403, 'forbidden');
            const body = parseJson<{ id?: string; status?: string; summary?: string; found?: { title?: unknown; items?: unknown } }>(req);
            const task = body.id ? store.getBrowseTask(body.id) : null;
            if (!task) throw new HttpError(404, 'no such task');
            const summary = String(body.summary ?? '').trim().slice(0, 1500) || 'The web task finished without a result.';
            if (store.finishBrowseTask(task.id, String(body.status ?? 'done'), summary)) {
                const address = { channel: task.channel, handle: task.handle };
                await router.send(address, summary).catch((error: Error) => log.error(`browse result send failed: ${error.message}`));
                const card = deps.cards && task.channel === 'imessage' && body.found ? resultCard({ title: body.found.title || task.goal, items: body.found.items }) : null;
                if (card) {
                    try {
                        await router.sendFile(address, await deps.cards!.render(card), `[card: ${captionFor(card)}]`);
                    } catch (error) {
                        log.warn(`result card failed: ${(error as Error).message}`);
                    }
                }
            }
            return json(200, { ok: true });
        },

        'POST /admin/reply': async (req) => {
            requireAdmin(req);
            const body = parseJson(req);
            const address = addressFrom(body);
            const text = String(body.text ?? '').trim();
            if (!text) throw new HttpError(400, 'text is required');
            await router.sendAsOperator(address, text);
            return json(200, { ok: true });
        },

        'POST /admin/release': (req) => {
            requireAdmin(req);
            const address = addressFrom(parseJson(req));
            store.endHandoff(address.channel, address.handle);
            return json(200, { ok: true });
        },

        'POST /admin/slots': (req) => {
            requireAdmin(req);
            const body = parseJson(req);
            try {
                const id = store.addSlot(String(body.startsAt ?? ''), String(body.endsAt ?? ''), String(body.label ?? ''));
                return json(201, { id });
            } catch (error) {
                throw new HttpError(400, (error as Error).message);
            }
        },

        'GET /admin/slots': (req) => {
            requireAdmin(req);
            return json(200, { slots: store.allSlots() });
        },
    };
}
