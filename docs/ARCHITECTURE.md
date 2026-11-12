# Architecture

Everything runs on one Mac mini as a handful of small Node processes. They talk over HTTP on `127.0.0.1`, so any one of them can restart without taking the others down.

| Process | Code | Listens on | Job |
|---|---|---|---|
| Agent server | `src/server.ts` | `127.0.0.1:3000` | All channels in, all replies out, the model, tools, storage |
| Mac line bridge | `bridges/mac/bridge.ts` | `127.0.0.1:3101` | The Mac's own iMessage account |
| iPhone line bridge, one per phone | `bridges/phone/bridge.ts` | `127.0.0.1:32xx` | One jailbroken iPhone running SMServer |
| Browser worker | `worker/browser-worker.ts` | `127.0.0.1:3105` | Web tasks in real Chrome |
| Line watchdog | `src/ops/line-watchdog.ts` | none | Alerts when a line stops answering |
| Games watcher | `games/watcher.ts` | none | Plays GamePigeon moves on iPhone lines |
| Phone tweak, on each iPhone | `ios/tweak/` | phone `:8799` | Photos, voice notes, reactions, cards, game moves |

Only the agent server needs to be reachable from the internet, and only if you use email, Slack or Twilio (their webhooks). Put a tunnel or HTTPS reverse proxy in front of `/channels/*` only.

## One message, end to end

1. A customer texts the line's number.
2. **Inbound.** The Mac bridge sees the new row in `~/Library/Messages/chat.db`; a phone bridge sees it in SMServer's chat list. Either posts `{line, from, text, guid}` to `POST /inbound/imessage` with the shared `X-Bridge-Key`. A bridge only moves past a message once the server took it, so a server restart delays messages instead of losing them.
3. **Pipeline** (`src/agent/pipeline.ts`):
   1. dedupe by message id (bridges retry)
   2. store the contact and the message
   3. STOP / START keywords
   4. if a human owns the conversation, forward it to them and stop
   5. per-person reply cap
   6. wait `REPLY_DEBOUNCE_MS` so three quick texts get one answer
   7. call the model with the conversation and the tools; run any tools it calls; repeat until it answers
4. **Outbound.** `src/channels/router.ts` is the only way out. It refuses anyone who never messaged us or who opted out, splits a text reply into a few bubbles, and hands each to the channel. For iMessage that means `POST /send` on the bridge for the line the person used, so the reply comes from the number they texted.

## Data

One SQLite file (`DATABASE_PATH`, via Node's built-in `node:sqlite`, no native build). Tables: `contacts`, `messages`, `seen` (dedupe), `reminders`, `slots` (bookable appointments), `browse` (web tasks). See `src/store.ts`. Back it up like any database; it holds your customers' conversations.

Bridges keep a small JSON state file each in `data/` (their cursors).

## The model

`src/agent/llm.ts` speaks the OpenAI-compatible Chat Completions API with tool calls, using plain `fetch`. Point `LLM_BASE_URL` at any provider or local server that implements it. The system prompt (`src/agent/prompt.ts`) is generic on purpose; your business facts go in `BUSINESS_INFO_FILE`.

Tools (`src/agent/tools.ts`): `set_reminder`, `list_reminders`, `cancel_reminder`, `list_open_slots`, `book_slot`, `list_my_bookings`, `cancel_booking`, `handoff_to_human`, `browse_web` when the worker is configured, `reply_with_voice_note` when text to speech is, and `send_card` when picture cards are (`src/cards/`). Every tool acts only for the person in the conversation.

## Design choices, and why

- **Receive and send are separate paths.** On the Mac, reading `chat.db` and driving Messages never share a queue, so a stuck send cannot stop inbound. This came from a production incident.
- **Cursors, not "seen" lists.** Message row ids only go up. One number per chat says what was handled, and a first start begins at the newest message, so history never replays. An older design replayed old texts to people when their chat woke up.
- **Wait for rows to settle.** Messages writes a row before it attaches the sender and chat. Reading too early and guessing the sender once made the bot reply to its own number in a loop.
- **Read words from `attributedBody`.** Messages clears `message.text` seconds after writing it; the words survive in an archived attributed string (`bridges/mac/attributed-body.ts`).
- **Verify sends on the phone.** SMServer answers 200 even when a send silently fails, so the phone bridge looks for the sent row on the phone and reports `verified`.
- **Alerts never go through the lines.** A down line cannot announce its own outage; alerts go to a Slack webhook.
- **The watchdog does not heal.** See [OPERATIONS.md](OPERATIONS.md#why-the-watchdog-only-alerts).
