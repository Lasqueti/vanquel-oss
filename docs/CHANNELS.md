# Channels

| Channel | Status | In | Out |
|---|---|---|---|
| iMessage, Mac line | Ported from production, unit tested | `chat.db` watcher | `imsg` CLI or AppleScript |
| iMessage, iPhone lines | Ported from production, unit tested | SMServer polling | SMServer `/send`, verified on the phone |
| **SMS on an iPhone line (the normal way)** | Same code as above | People without iMessage text the same number; green-bubble threads arrive like any other | Replies go out on the thread's own service, so SMS threads get SMS from the same phone |
| SMS through Twilio (optional, not needed) | **New in this repo. Unit tested only; never run against a live Twilio account.** | Twilio webhook, signature checked | Twilio Messages API |
| Email through Postmark | **New in this repo. Unit tested only; never run against a live Postmark server.** | Postmark inbound webhook, token checked | Postmark email API, threaded replies |
| Slack | **New in this repo. Unit tested only; never run against a live Slack workspace.** | Events API, signature checked | `chat.postMessage` |

"New in this repo" means the production system this code comes from did not have it: there, iMessage was the only conversation channel, email was only sent through each user's own Gmail with their consent (a different feature, not included), and there was no Slack or Twilio SMS. These adapters are small and follow each provider's documented formats, but test them on a real account before you rely on them, and please report what you find.

## iMessage

See [MAC-MINI.md](MAC-MINI.md) for the Mac line and [PHONES.md](PHONES.md) for iPhone lines. Every line is listed in `IMESSAGE_LINES`; a person's replies always leave from the line they last texted.

## SMS

**You do not need Twilio for SMS.** Each iPhone line is a real phone number with a real SIM, so it handles SMS as well as iMessage: someone on Android texts the same number, the bridge passes it to the agent, and the reply goes back as SMS from that same phone. Nothing to set up beyond the line itself.

## SMS through Twilio (optional)

Only if you want a separate SMS-only number with no phone behind it.

1. Buy a number in Twilio with SMS enabled. Note US rules: application-to-person SMS needs A2P 10DLC registration (or a verified toll-free number) before carriers will deliver it.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `PUBLIC_BASE_URL`.
3. In Twilio, set the number's incoming message webhook to `POST {PUBLIC_BASE_URL}/channels/sms/twilio`.

The signature check uses `PUBLIC_BASE_URL` plus the request path, so it must match exactly the URL you gave Twilio.

## Email through Postmark

1. Set up a Postmark server with an inbound stream and a sender signature or verified domain for `EMAIL_FROM_ADDRESS`.
2. Set `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM_ADDRESS`, `EMAIL_INBOUND_TOKEN` (long random string).
3. Set the inbound webhook URL to `{PUBLIC_BASE_URL}/channels/email/postmark?token={EMAIL_INBOUND_TOKEN}`.

Replies keep the subject (`Re: ...`) and thread with `In-Reply-To`. Quoted history under a reply is stripped before the agent reads it.

## Slack

Create a Slack app with a bot user.

- Scopes: `chat:write`, `im:history`, `channels:history` (for the operator channel), `groups:history` if that channel is private.
- Event subscriptions: request URL `{PUBLIC_BASE_URL}/channels/slack/events`; bot events `message.im` and `message.channels` (or `message.groups`).
- Turn on the Messages tab in App Home so people can DM it.
- Set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `SLACK_OPERATOR_CHANNEL` (the channel id); invite the bot to that channel.
- `SLACK_DM_CHANNEL=0` uses Slack only as the handoff console.

**Handoff console.** When the agent hands a conversation to a person, a thread opens in the operator channel with who it is and why. Every new customer message lands in that thread. Anything a teammate writes in the thread is sent to the customer (on whatever channel they used). Writing `done` hands the conversation back to the agent.

## Not in this release

Honest list of what the production system did that this repository does not, yet:

- **Group chats.** Group messages are received but never answered (`ignored-group`).
- **Photos, files and voice notes,** in or out. Text only.
- **Tapbacks** (reactions) are ignored.
- **Typing indicators and read receipts.**
- **Native iMessage app cards and GamePigeon games.** These needed custom on-device tweaks that are risky to run; they are not included.
- **Contact card on first message.**
- **Auto-healing watchdog.** Alert only, on purpose; see [OPERATIONS.md](OPERATIONS.md#why-the-watchdog-only-alerts).
- **Acting in a customer's own Gmail or calendar.**
