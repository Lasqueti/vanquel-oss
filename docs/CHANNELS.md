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

## Group chats

A group is its own conversation: the agent replies in the group, never in a member's private chat, and it does not mix what it knows from private chats into the group.

- It speaks when someone uses its name (`AGENT_NAME`), or answers a question it just asked. Otherwise it stays quiet. "Everyone" or "you guys" does not count.
- The model can also decide to say nothing (it answers `NO_REPLY`).
- In a group it only talks: no bookings, reminders or web tasks. It offers to help one on one instead.
- SMS, MMS and RCS groups (any member on green bubbles) are left quietly and never answered, as in production.
- STOP in a group opts that group out.

## Photos, voice notes, reactions, typing

- **Photos people send** reach the agent. With `LLM_VISION=1` the model sees the image; otherwise it is told a photo arrived. Other files become a short note.
- **Voice-note replies:** set `TTS_MODEL` and the agent can answer a short message as a native voice note (text to speech, converted on the Mac, sent as a real waveform bubble). Anything long or full of links stays text.
- **Reactions** (tapbacks) are kept as context and never trigger a reply.
- **Typing dots** show while the agent writes. iPhone lines use SMServer; the Mac line needs `MAC_TYPING=1` and an `imsg` build with typing.
- **Contact card:** with `SEND_CONTACT_CARD=1` a new person gets your business card after the first reply.

## Picture cards

With `CARDS=1` the agent can send a designed card on iMessage lines. These are the production card designs (`src/cards/`), drawn by headless Google Chrome and sent as a picture, so every customer sees them:

| Card | When | Where the data comes from |
|---|---|---|
| Bookings | "when is my appointment?" | The person's own bookings in the database |
| Reminders | "what did I ask you to remind me about?" | The person's own reminders in the database |
| Confirm | Before the agent books, cancels or changes something | The agent writes it: a title, the details, and what to reply |
| Web task result | A web task found a short list (stores, products, times) | The browser worker, checked and capped by the server |

The agent sends at most one card per reply, always after its words, so a card that fails to draw costs nothing. Cards about a person's bookings and reminders are built from the database, never from the model's text, so a card cannot show a booking that does not exist. Text on a card is escaped and the page that draws it runs no scripts and loads nothing.

Set `CARD_THEME=dark` for the black iMessage look; light is the default. See every card with sample data: `npm run cards:preview`.

**Tappable native cards** (the kind that open inside Messages) only show for people who have installed your own iPhone app with an iMessage extension; everyone else gets an empty bubble. Production proved this on real phones. The bridges and phone tweak can send them (`/send-card`), but the app is yours to build, so this release sends pictures.

On iPhone lines, photos and voice notes go out through the phone tweak ([ios/tweak/README.md](../ios/tweak/README.md)), because SMServer silently drops files on rootless jailbreaks. Without the tweak, an iPhone line is text only.

## GamePigeon games

iPhone lines with the phone tweak can play GamePigeon with your customers: Word Hunt on by default, eleven more games switchable one by one. A separate process (`npm run games`) does it. See [games/README.md](../games/README.md).

## Status of all of the above

Group chats, photos, voice notes, typing, reactions, the contact card, picture cards, the phone tweak and the games were ported from production and are unit tested here, but have **not yet been run in this repository against a real phone or Mac**. Test on a spare line before customers use it.

## Not in this release

Honest list of what the production system did that this repository does not, yet:

- **Voice notes people send** are not transcribed; the agent is told one arrived.
- **Read receipts**, and the agent sending its own tapbacks (the bridges support `/tapback`; the agent has no tool for it yet).
- **Tappable native app cards.** The bridges and tweak can send them (`/send-card`), but they only show for people who installed your own iPhone app, so the agent sends picture cards instead (see Picture cards above). Production's personal tracker cards (calories, workouts, sleep and the rest) belong to a different product and are not included.
- **8 Ball and Mini Golf engines.** They are compiled from AGPL source that was not available to publish with them, so they are not shipped; see games/README.md to build them.
- **Production's extra group features:** learned nicknames, polls and bookings in groups.
- **The full production browser agent** (saved logins, purchases, documents, the Chrome extension). The worker here is a smaller rebuild.
- **Acting in a customer's own Gmail or calendar.**
- **Auto-healing watchdog.** Alert only, on purpose; see [OPERATIONS.md](OPERATIONS.md#why-the-watchdog-only-alerts).
