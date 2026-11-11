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
            // Group chats are out of scope for this release: never answered.
            if (message.isGroup) return json(200, { result: 'ignored-group' });
            const result = await pipeline.handleInbound({ address: { channel: 'imessage', handle: message.from, line: message.line }, text: message.text, externalId: message.guid });
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
            const body = parseJson<{ id?: string; status?: string; summary?: string }>(req);
            const task = body.id ? store.getBrowseTask(body.id) : null;
            if (!task) throw new HttpError(404, 'no such task');
            const summary = String(body.summary ?? '').trim().slice(0, 1500) || 'The web task finished without a result.';
            if (store.finishBrowseTask(task.id, String(body.status ?? 'done'), summary)) {
                await router.send({ channel: task.channel, handle: task.handle }, summary).catch((error: Error) => log.error(`browse result send failed: ${error.message}`));
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
