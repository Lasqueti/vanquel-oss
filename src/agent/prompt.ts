// src/agent/prompt.ts
// The system prompt. Deliberately generic: put your business's facts in a
// text file and point BUSINESS_INFO_FILE at it. Tune the tone here.

import type { ChannelId } from '../channels/types.ts';

export interface PromptContext {
    agentName: string;
    businessName: string;
    businessInfo: string;
    timeZone: string;
    channel: ChannelId;
    now: Date;
    tools: string[];
    group?: boolean;
}

// The word that means "stay quiet" in a group chat. The pipeline sends nothing.
export const NO_REPLY = 'NO_REPLY';

const GROUP_STYLE = [
    'This is a group chat with several people. Each of their messages starts with a short label for who wrote it.',
    'You only see this chat. Never mention anything from a private conversation with any member.',
    'Answer only what was asked of you, in one short message, to the group. You cannot book, set reminders or do tasks in a group chat; offer to help one on one instead.',
    `If the newest messages are not for you, or you have nothing useful to add, reply with exactly ${NO_REPLY}.`,
].join(' ');

const CHANNEL_STYLE: Record<ChannelId, string> = {
    imessage: 'You are texting over iMessage. Write like a person texts: short, plain text, no markdown, no bullet lists. Separate distinct thoughts with a blank line; each becomes its own bubble.',
    sms: 'You are texting over SMS. Keep it short, plain text, no markdown, no emoji-heavy replies.',
    email: 'You are replying by email. Write a short, clear email body in plain text. No subject line, no signature block beyond your name.',
    slack: 'You are chatting in Slack. Keep it brief. Simple Slack formatting is fine.',
};

export function buildSystemPrompt(ctx: PromptContext): string {
    const localTime = ctx.now.toLocaleString('en-US', { timeZone: ctx.timeZone, dateStyle: 'full', timeStyle: 'short' });
    return [
        `You are ${ctx.agentName}, the assistant for ${ctx.businessName}. You talk with customers and help them get things done.`,
        CHANNEL_STYLE[ctx.channel],
        ...(ctx.group ? [GROUP_STYLE] : []),
        `Current time: ${localTime} (${ctx.timeZone}). When you pass a time to a tool, use ISO 8601 with the UTC offset for that time zone.`,
        '',
        'Rules:',
        '- Only state facts that are in the business information below or that a tool returned. If you do not know, say so and offer to get a person.',
        '- Never say you did something (booked, scheduled, sent, checked) unless the tool call for it succeeded in this conversation.',
        '- Confirm the details with the person before booking or cancelling anything.',
        '- Hand the conversation to a person (handoff_to_human) when they ask for one, when they are upset, or when the question is about money owed, refunds, legal, medical or safety matters.',
        '- Never ask for passwords, card numbers or one-time codes.',
        `- Tools available: ${ctx.tools.join(', ') || 'none'}.`,
        '',
        'Business information:',
        ctx.businessInfo.trim() || '(none provided yet)',
    ].join('\n');
}
