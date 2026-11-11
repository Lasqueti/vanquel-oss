// src/channels/slack.ts
// Slack, two jobs:
//   1. A channel people can talk to the agent on: they DM the Slack app.
//   2. The operator console: when the agent hands a conversation to a human,
//      it opens a thread in SLACK_OPERATOR_CHANNEL. Whatever a person types in
//      that thread is sent to the customer; typing "done" hands it back.
//
// STATUS: new in this repo. Tested with unit tests against Slack's documented
// request signing and event shapes; it has not been run against a live Slack
// workspace. The production system this repo comes from had no Slack code.
//
// Inbound:  Slack Events API POSTs to /channels/slack/events.
// Outbound: POST https://slack.com/api/chat.postMessage

import { createHmac } from 'node:crypto';
import type { Address, Channel } from './types.ts';
import { safeEqual } from '../http.ts';

export interface SlackConfig {
    botToken: string;
    fetchImpl?: typeof fetch;
}

const MAX_SKEW_SECONDS = 5 * 60;

// Slack's v0 scheme: HMAC-SHA256 of "v0:<timestamp>:<raw body>".
export function slackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
    return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

export function verifySlackRequest(signingSecret: string, timestamp: string, rawBody: string, signature: string, nowSeconds = Date.now() / 1000): boolean {
    const ts = Number(timestamp);
    if (!signature || !Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
    return safeEqual(slackSignature(signingSecret, timestamp, rawBody), signature);
}

export type SlackEvent =
    | { kind: 'challenge'; challenge: string }
    | { kind: 'dm'; eventId: string; channel: string; user: string; text: string }
    | { kind: 'thread-reply'; eventId: string; channel: string; threadTs: string; user: string; text: string }
    | { kind: 'ignore' };

type SlackBody = {
    type?: string;
    challenge?: string;
    event_id?: string;
    event?: { type?: string; subtype?: string; bot_id?: string; channel?: string; channel_type?: string; user?: string; text?: string; thread_ts?: string; ts?: string };
};

export function parseSlackEvent(body: SlackBody, operatorChannel: string): SlackEvent {
    if (body.type === 'url_verification' && body.challenge) return { kind: 'challenge', challenge: body.challenge };
    const event = body.event;
    if (body.type !== 'event_callback' || !event || event.type !== 'message') return { kind: 'ignore' };
    // Edits, joins, and anything a bot (including us) posted are not people talking.
    if (event.subtype || event.bot_id || !event.user || !event.channel) return { kind: 'ignore' };
    const eventId = body.event_id ?? `${event.channel}:${event.ts}`;
    const text = (event.text ?? '').trim();
    if (event.channel === operatorChannel && event.thread_ts && event.thread_ts !== event.ts) {
        return { kind: 'thread-reply', eventId, channel: event.channel, threadTs: event.thread_ts, user: event.user, text };
    }
    if (event.channel_type === 'im') return { kind: 'dm', eventId, channel: event.channel, user: event.user, text };
    return { kind: 'ignore' };
}

export function createSlackClient(config: SlackConfig) {
    const fetchImpl = config.fetchImpl ?? fetch;
    async function postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
        const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
            signal: AbortSignal.timeout(20_000),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
        if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error ?? response.status}`);
        return data.ts ?? '';
    }
    return { postMessage };
}

export type SlackClient = ReturnType<typeof createSlackClient>;

export function createSlackChannel(client: SlackClient): Channel {
    return {
        id: 'slack',
        style: 'block',
        async send(address: Address, text: string) {
            await client.postMessage(address.handle, text);
        },
    };
}
