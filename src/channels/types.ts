// src/channels/types.ts
// The one shape every channel shares. A person is an Address: which channel,
// their handle on it (phone number, email, Slack DM id), and for iMessage the
// line (phone number the business owns) the conversation lives on, so a reply
// always leaves from the number the person texted.

export type ChannelId = 'imessage' | 'sms' | 'email' | 'slack';

export interface Address {
    channel: ChannelId;
    handle: string;
    // iMessage only: which line (bridge) the person texts.
    line?: string;
    // Email only: JSON {subject, messageId} of the last inbound mail, for threading.
    thread?: string;
}

export interface InboundMessage {
    address: Address;
    text: string;
    // A stable id from the source (iMessage guid, email Message-ID, Slack event id).
    externalId?: string;
}

export interface Channel {
    id: ChannelId;
    // Text-message channels get short bubbles; email and Slack get one block.
    style: 'bubbles' | 'block';
    send(address: Address, text: string): Promise<void>;
}
