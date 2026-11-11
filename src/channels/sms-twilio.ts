// src/channels/sms-twilio.ts
// SMS through Twilio, for a business that wants a normal SMS number next to
// (or instead of) the iPhone lines.
//
// STATUS: new in this repo. Tested against Twilio's documented formats with
// unit tests only; it has not been run against a live Twilio account. The
// production system this repo comes from never used Twilio for SMS.
//
// Inbound:  Twilio POSTs form fields (From, To, Body, MessageSid) to
//           /channels/sms/twilio. We check X-Twilio-Signature.
// Outbound: POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json

import { createHmac } from 'node:crypto';
import type { Address, Channel } from './types.ts';
import { safeEqual } from '../http.ts';

export interface TwilioConfig {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    fetchImpl?: typeof fetch;
}

// Twilio's scheme: HMAC-SHA1 over the full URL followed by every POST param
// (sorted by name) as name+value, base64, keyed with the auth token.
export function twilioSignature(authToken: string, fullUrl: string, params: Record<string, string>): string {
    const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], fullUrl);
    return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(authToken: string, fullUrl: string, params: Record<string, string>, signature: string): boolean {
    if (!signature) return false;
    return safeEqual(twilioSignature(authToken, fullUrl, params), signature);
}

export function parseTwilioInbound(params: Record<string, string>): { from: string; text: string; id: string } | null {
    const from = (params.From ?? '').trim();
    const id = (params.MessageSid ?? params.SmsSid ?? '').trim();
    if (!from || !id) return null;
    return { from, text: (params.Body ?? '').trim(), id };
}

export function createTwilioChannel(config: TwilioConfig): Channel {
    const fetchImpl = config.fetchImpl ?? fetch;
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    return {
        id: 'sms',
        style: 'bubbles',
        async send(address: Address, text: string) {
            const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
                method: 'POST',
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ From: config.fromNumber, To: address.handle, Body: text }).toString(),
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error(`Twilio answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
        },
    };
}
