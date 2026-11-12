// src/channels/types.ts
// The one shape every channel shares. A conversation is an Address: which
// channel, the handle on it (phone number, email, Slack DM id), and for
// iMessage the line (phone number the business owns) the conversation lives
// on, so a reply always leaves from the number the person texted.
//
// Group chats: an iMessage group is its own conversation. Its handle is the
// group chat id the bridge reports, never a member's number, so a group reply
// can only go back to the group. Who wrote each group message is kept per
// message (InboundMessage.sender), not in the Address.

export type ChannelId = 'imessage' | 'sms' | 'email' | 'slack';

export interface Address {
    channel: ChannelId;
    handle: string;
    // iMessage only: which line (bridge) the person texts.
    line?: string;
    // Email only: JSON {subject, messageId} of the last inbound mail, for threading.
    thread?: string;
    // iMessage only: the handle is a group chat id.
    group?: boolean;
}

// A file that came with a message. url is on a bridge of this machine.
export interface Attachment {
    url: string;
    mimeType: string;
    fileName: string;
}

export interface InboundMessage {
    address: Address;
    text: string;
    // A stable id from the source (iMessage guid, email Message-ID, Slack event id).
    externalId?: string;
    // Group chats: the member who wrote it.
    sender?: string;
    attachments?: Attachment[];
    // iMessage: the service the bridge saw ("iMessage", "SMS", "RCS").
    service?: string;
}

export interface Channel {
    id: ChannelId;
    // Text-message channels get short bubbles; email and Slack get one block.
    style: 'bubbles' | 'block';
    send(address: Address, text: string): Promise<void>;
    // Optional, iMessage only. Absolute paths on this machine; audio marks a
    // voice note.
    sendFiles?(address: Address, files: string[], options?: { audio?: boolean }): Promise<void>;
    // Optional, iMessage only. The "..." bubble; best effort.
    typing?(address: Address): Promise<void>;
}
