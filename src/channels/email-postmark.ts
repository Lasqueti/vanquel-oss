// src/channels/email-postmark.ts
// Email through Postmark: the agent gets its own mailbox (for example
// help@yourdomain), people email it, it answers in the same thread.
//
// STATUS: new in this repo. Tested against Postmark's documented JSON with
// unit tests only; it has not been run against a live Postmark server. The
// production system this repo comes from only sent email through each user's
// own Gmail (with their OAuth consent), which is a different feature and is
// not included here.
//
// Inbound:  Postmark's inbound webhook POSTs JSON to
//           /channels/email/postmark?token=<EMAIL_INBOUND_TOKEN>
// Outbound: POST https://api.postmarkapp.com/email

import type { Address, Channel } from './types.ts';

export interface PostmarkConfig {
    serverToken: string;
    fromAddress: string;
    fetchImpl?: typeof fetch;
}

export interface EmailThread {
    subject: string;
    messageId: string;
}

export interface ParsedEmail {
    from: string;
    text: string;
    id: string;
    thread: EmailThread;
}

type PostmarkInbound = {
    From?: string;
    FromFull?: { Email?: string };
    Subject?: string;
    TextBody?: string;
    StrippedTextReply?: string;
    MessageID?: string;
    Headers?: Array<{ Name?: string; Value?: string }>;
};

// Strips the quoted history most mail clients add under a reply.
export function stripQuoted(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const cut = lines.findIndex((line) => /^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || line.startsWith('>'));
    return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim();
}

export function parsePostmarkInbound(body: PostmarkInbound): ParsedEmail | null {
    const from = (body.FromFull?.Email ?? body.From ?? '').trim().toLowerCase();
    const headerId = body.Headers?.find((h) => h.Name?.toLowerCase() === 'message-id')?.Value?.trim();
    const id = (headerId || body.MessageID || '').trim();
    if (!from || !id) return null;
    const text = (body.StrippedTextReply?.trim() || stripQuoted(body.TextBody ?? '')).slice(0, 8000);
    return { from, text, id, thread: { subject: (body.Subject ?? '').trim(), messageId: id } };
}

export function replySubject(subject: string): string {
    if (!subject) return 'Re: your message';
    return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function createPostmarkChannel(config: PostmarkConfig): Channel {
    const fetchImpl = config.fetchImpl ?? fetch;
    return {
        id: 'email',
        style: 'block',
        async send(address: Address, text: string) {
            let thread: EmailThread = { subject: '', messageId: '' };
            try {
                if (address.thread) thread = JSON.parse(address.thread) as EmailThread;
            } catch {
                // An unreadable thread just means a fresh subject line.
            }
            const headers = thread.messageId
                ? [{ Name: 'In-Reply-To', Value: thread.messageId }, { Name: 'References', Value: thread.messageId }]
                : [];
            const response = await fetchImpl('https://api.postmarkapp.com/email', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.serverToken },
                body: JSON.stringify({
                    From: config.fromAddress,
                    To: address.handle,
                    Subject: replySubject(thread.subject),
                    TextBody: text,
                    Headers: headers,
                    MessageStream: 'outbound',
                }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error(`Postmark answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
        },
    };
}
