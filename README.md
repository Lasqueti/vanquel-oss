# Vanquel OSS

**A self-hosted AI agent your customers can text.** Blue-bubble iMessage from a Mac mini and a few old iPhones, plus SMS, email and Slack. It answers questions, books appointments, sends reminders, does web errands in a real browser, and hands the conversation to a human when it should.

This is the stack we built and ran in production at Vanquel, pulled out into its own clean repository. No vendor API sits between you and iMessage: you own the phones, the numbers and the code.

Don't want to run phones yourself? If you don't want to pay $167/month with restrictions, we'll host the infrastructure for you for $50/month with no message limits: [vanquel.com](https://vanquel.com).

> **Read this first.** Running iMessage through jailbroken iPhones and a Mac this way is not something Apple supports. It may break Apple's terms of service, Apple can change iOS or its servers and break it at any time, and numbers that send spam get flagged and cut off. Read [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md) before you send a single message.

## What's in the box

| Part | What it does | Status |
|---|---|---|
| [Agent server](src/) | Receives every message, runs the model with tools, sends the reply. Opt-out (STOP), per-person rate limit, human handoff. | Working, unit tested |
| [Mac line bridge](bridges/mac/) | The Mac mini's own Messages account as a line: reads `chat.db`, sends through Messages. | Ported from production, unit tested |
| [iPhone line bridge](bridges/phone/) | One per jailbroken iPhone running SMServer. **This is also your SMS:** people without iMessage text the same number and get SMS replies from the same phone. No Twilio needed. | Ported from production, unit tested |
| [Phone guide](docs/PHONES.md) | Which iPhones and iOS versions, jailbreaking, SMServer, recovery. | From production runbooks |
| [Browser worker](worker/) | Does web tasks in real Chrome. Stops before payments, passwords and private networks. | Rebuilt small, unit tested |
| [Email](src/channels/email-postmark.ts) | The agent's own mailbox through Postmark. | **New, not run against live Postmark yet** |
| [Slack](src/channels/slack.ts) | Customers DM the agent; teammates take over handoffs in a thread. | **New, not run against live Slack yet** |
| [Twilio SMS](src/channels/sms-twilio.ts) | Optional. Not needed for SMS (the iPhone lines do it); only for a separate SMS-only number. | **New, not run against live Twilio yet** |
| [Phone tweak](ios/tweak/) | Optional add-on on each iPhone: photos, native voice notes, reactions, app cards. The riskiest layer; test on a spare phone. | Ported from production, not yet built or run from this repo |
| [GamePigeon games](games/) | Plays Word Hunt and eleven more GamePigeon games with customers on iPhone lines. | Ported from production, unit tested |
| Groups and media | Group chats, photos in, voice-note replies, reactions, typing dots, contact card. | Ported from production, unit tested |
| [Line watchdog](src/ops/line-watchdog.ts) | Alerts you when a line goes down. Alert only, on purpose. | Working, unit tested |

What is **not** in this release is listed honestly in [docs/CHANNELS.md](docs/CHANNELS.md#not-in-this-release): transcribing voice notes people send, custom app card designs, the 8 Ball and Mini Golf engines, the full production browser agent, and an auto-healing watchdog.

## What's in each folder

| Folder or file | What it is |
|---|---|
| `src/` | The agent server: receives messages on every channel, runs the AI with its tools, sends replies |
| `bridges/` | iMessage and SMS bridges: `mac/` for the Mac mini's own line, `phone/` for each jailbroken iPhone line |
| `worker/` | The browser worker: does web tasks for customers in real Chrome |
| `ios/` | Files that go on the iPhones: SMServer's launch daemon, its memory-limit launcher, and the phone tweak (`ios/tweak/`) |
| `games/` | GamePigeon auto-play: game solvers and the watcher process |
| `lines/` | Settings template for one iPhone line |
| `scripts/` | Phone health check and recovery helpers, and the secret and privacy scanner |
| `tests/` | Automated tests (`npm test`) |
| `docs/` | Setup and operations guides |
| `.env.example` | Every setting, with comments. Copy it to `.env` |
| `business.example.txt` | Example of the business facts the agent answers from |
| `ecosystem.config.json` | Runs every process on the Mac mini with pm2 |

## How it fits together

```
 customer's iPhone                                   your Mac mini
 ─────────────────                                   ─────────────────────────────────────────────
                     iMessage / SMS
   texts  ───────────────────────────►  line iPhone ──SMServer:8741──► bridges/phone ──┐
                                        (jailbroken)                                  │
   texts  ───────────────────────────►  Messages.app ──chat.db───────► bridges/mac ────┤  POST /inbound/imessage
                                                                                      ▼
   email  ── Postmark webhook ───────────────────────────────────────────────────►  agent server (src/)
   Slack  ── Events API ─────────────────────────────────────────────────────────►    store (SQLite)
   SMS    ── same iPhone line as above, or optionally a Twilio webhook ──────────►    model + tools
                                                                                      │   reminders, bookings,
                                                                                      │   handoff, browse_web
                                                                                      ▼
                                                              reply goes back out the same channel and line
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Hardware

| Item | Notes |
|---|---|
| Mac mini | Any Apple silicon model on a recent macOS. It runs everything: server, bridges, browser worker. Keep it plugged in, logged in, and set to never sleep. |
| iPhones (optional, one per extra line) | **iPhone 6s recommended**, jailbroken through the Tips app (TrollStore, then Dopamine), so no cable is needed after setup. iPhone 7 and 8 also work. iOS cannot be downgraded, so **ask the seller the exact iOS version before you buy.** See [docs/PHONES.md](docs/PHONES.md#our-recommendation). |
| A SIM with a plan for each iPhone | The phone number is the line, for both iMessage and SMS. Use a real, long-term SIM: a temporary SIM will most likely get the number locked out of iMessage, and you will have to contact Apple Support to unlock it (in our experience they always have). See [docs/PHONES.md](docs/PHONES.md#sim-cards-and-imessage-activation). |
| A 5 W or stronger **wall** charger per phone | Not a computer USB port. A phone that slowly drains and powers off loses its jailbreak. |
| A Lightning USB cable | Needed for palera1n or checkra1n re-jailbreaks after a full reboot. |
| A router with DHCP reservations | Each phone needs a fixed LAN address. A separate network or VLAN for the phones is strongly recommended. |
| A way to reach the Mac from the internet | Only for email, Slack and (optional) Twilio webhooks: a tunnel (for example Cloudflare Tunnel) or a reverse proxy with HTTPS. iMessage alone needs no inbound internet access. |

You can start with **only the Mac mini**: its own Messages account is a working line. Add iPhones when you need more numbers.

## Quickstart (Mac mini, Mac line only)

Requirements: Node.js 22.18 or newer (Node 24 LTS recommended), Messages signed in on the Mac.

```bash
git clone <this repo> vanquel-oss && cd vanquel-oss
npm install
cp .env.example .env            # fill in LLM_*, BRIDGE_KEY, BUSINESS_* at minimum
cp business.example.txt business.txt   # then write your own business facts in it
npm run check                   # typecheck, tests, secret scan
```

Then give the Node binary **Full Disk Access** (System Settings, Privacy and Security) so the bridge can read `~/Library/Messages/chat.db`, install the [imsg](https://github.com/steipete/imsg) CLI or set `MAC_SEND_VIA=applescript`, and start:

```bash
npm start              # agent server on 127.0.0.1:3000
npm run bridge:mac     # the Mac line
```

Text the Mac's number from another phone. Full setup, including running everything under pm2 and starting on boot: [docs/MAC-MINI.md](docs/MAC-MINI.md).

## Commands

| Command | What it does |
|---|---|
| `npm start` | Agent server |
| `npm run bridge:mac` | Mac line bridge |
| `npm run bridge:phone -- lines/phone1.env` | One iPhone line bridge |
| `npm run worker` | Browser worker |
| `npm run watchdog` | Line watchdog (alerts) |
| `npm run games` | GamePigeon games on iPhone lines |
| `npm run check` | Typecheck, tests, and the secret/PII scan. Run before every commit. |

Everything is TypeScript run directly by Node (type stripping), so there is no build step. `npm run typecheck` runs `tsc --noEmit`.

## Safety built in

- The agent can only message people who messaged it first. There is no code path that starts a conversation with a stranger.
- STOP opts a person out at once, with one confirmation. START opts back in.
- Per-person reply cap (`MAX_REPLIES_PER_HOUR`).
- The agent never says it did something unless the tool call succeeded, and hands off to a human for money, legal, medical or safety questions.
- The browser worker will not type passwords, card numbers or one-time codes, will not click anything that spends money, and will not open localhost or private network addresses.
- `npm run scan` fails on API keys, tokens, real-looking phone numbers, personal email addresses and private IPs.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): message flow, data, design choices
- [docs/PHONES.md](docs/PHONES.md): buying, jailbreaking, SMServer, adding a line, recovery
- [docs/MAC-MINI.md](docs/MAC-MINI.md): Mac setup, permissions, pm2, start on boot
- [docs/CHANNELS.md](docs/CHANNELS.md): what each channel does, how to set it up, what is not done
- [docs/BROWSER-WORKER.md](docs/BROWSER-WORKER.md): the web task worker and its limits
- [docs/OPERATIONS.md](docs/OPERATIONS.md): day to day running, handoffs, the admin API, incidents
- [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md): what you may and may not do with this
- [SECURITY.md](SECURITY.md): reporting a vulnerability, hardening checklist

## License

Copyright (C) 2026 the Vanquel authors. Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

In plain terms: you can use, change and self-host this for free. If you run a modified version as a service other people use over a network, you must offer those users your modified source code under the same license.
