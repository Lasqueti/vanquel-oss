# Mac mini setup

The Mac mini runs every process and is also the first iMessage line.

## The Mac itself

- macOS on Apple silicon, kept up to date.
- System Settings, Energy: prevent sleeping, start up automatically after a power failure.
- Stay logged in to the desktop (Messages and the browser worker's Chrome need a logged-in user session). Turn on automatic login for the service user, and use FileVault plus a strong account password.
- Messages: signed in with the Apple ID or number you want as the Mac line, iMessage enabled.
- A dedicated macOS user for this service is a good idea. Everything below assumes you are logged in as it.

## Software

```bash
brew install node            # Node 22.18 or newer; Node 24 LTS recommended
npm install -g pm2           # keeps the processes running
```

For sending, either install the [imsg](https://github.com/steipete/imsg) CLI (follow its README; check that `imsg send --help` lists `--to` and `--text`) or set `MAC_SEND_VIA=applescript` to drive Messages with AppleScript instead.

## Permissions

| Permission | Which binary | Why |
|---|---|---|
| Full Disk Access | `node` (the exact binary pm2 runs; `which node`) | Read `~/Library/Messages/chat.db` |
| Full Disk Access | `imsg`, if you use it | It reads Messages data too |
| Automation, Messages | `osascript` / your terminal | Only if `MAC_SEND_VIA=applescript`; macOS asks the first time |

macOS grants these per binary. After upgrading Node, check Full Disk Access again: a new binary path has no permission and the Mac bridge will fail to open `chat.db`.

## Install and configure

```bash
cd ~ && git clone <this repo> vanquel-oss && cd vanquel-oss
npm install
cp .env.example .env && chmod 600 .env
```

Fill in `.env`. At minimum: `LLM_API_KEY`, `LLM_MODEL`, `BRIDGE_KEY` (long random string), `ADMIN_TOKEN`, `BUSINESS_NAME`, `BUSINESS_INFO_FILE`, `TIMEZONE`, `IMESSAGE_LINES`. Generate random secrets with `openssl rand -hex 32`.

Run `npm run check` once. It must pass.

## Run under pm2

```bash
pm2 start ecosystem.config.json --only agent,bridge-mac,watchdog
pm2 save
pm2 startup        # prints a command; run it so pm2 starts at boot
```

Add `bridge-phone1` (and copies for more lines) once a phone is set up, and `browser-worker` if you use it. Edit `ecosystem.config.json` to match your line files.

**Start pm2 from a normal terminal** whose `PATH` includes Homebrew (`/opt/homebrew/bin`). In production, a pm2 daemon started with a bare `PATH` crashed while trying to restart itself, and left old bridge processes holding their ports.

## Exposing webhooks (only for email, Slack, Twilio)

Keep the server on `127.0.0.1` and put a tunnel in front of it, for example [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). Route only `/channels/*` publicly. Set `PUBLIC_BASE_URL` to the public https origin. `/admin/*`, `/inbound/*` and `/internal/*` should never be reachable from the internet; `/internal/*` additionally refuses anything that is not loopback.

## Logs

```bash
pm2 logs agent --lines 50 --nostream
pm2 logs bridge-mac --lines 50 --nostream
```

Logs show only the last four characters of phone numbers and emails.
