# Operations

## Daily

- `pm2 status`: everything `online`.
- The watchdog posts to `ALERT_SLACK_WEBHOOK_URL` when a line misses three health checks in a row, and again when it recovers.
- Restart SMServer on each phone every few days at a quiet hour ([PHONES.md](PHONES.md#routine-maintenance)).

## Human handoff

The agent hands a conversation to a person when asked, when someone is upset, or for money, legal, medical or safety questions. From then on it stays silent for that person until a teammate hands it back.

- **With Slack:** reply in the thread the handoff opened; write `done` to hand back. See [CHANNELS.md](CHANNELS.md#slack).
- **Without Slack:** use the admin API below.

## Admin API

On the Mac itself (never expose `/admin` publicly), with `ADMIN_TOKEN`:

```bash
TOKEN=...   # your ADMIN_TOKEN

# Reply to a customer as a human (logged as the operator, so the agent sees who said it)
curl -X POST http://127.0.0.1:3000/admin/reply -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"channel":"imessage","handle":"+15550100123","text":"Hi, this is Sam from the front desk."}'

# Hand the conversation back to the agent
curl -X POST http://127.0.0.1:3000/admin/release -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"channel":"imessage","handle":"+15550100123"}'

# Publish a bookable slot (times with a UTC offset), and list slots
curl -X POST http://127.0.0.1:3000/admin/slots -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"startsAt":"2030-03-02T10:00:00-05:00","endsAt":"2030-03-02T10:30:00-05:00","label":"Cleaning"}'
curl http://127.0.0.1:3000/admin/slots -H "Authorization: Bearer $TOKEN"
```

The admin API only reaches people who already messaged you, like everything else.

## Why the watchdog only alerts

The production system had a watchdog that recovered phones by itself. It also caused the worst outage: it recovered a phone at the same moment a person was working on it, two userspace reboots ran twenty seconds apart, the phone fully rebooted and lost its jailbreak, and someone had to re-jailbreak it by hand. Recovering a phone is a deliberate step a person takes, with nothing else touching that phone. The scripts in `scripts/phone/` do it safely, one phone at a time.

## Incidents we learned from

- **Every line down at once, phones fine.** The process manager's daemon died and old bridge processes kept holding their ports, answering every request with an empty reply; restarts could not fix it. Check `lsof -nP -iTCP:<port> -sTCP:LISTEN` and the owning process before blaming phones.
- **The bot replied to itself.** A message row was read before Messages attached its sender, and the sender was guessed from the line's own number. The Mac bridge now waits for rows to settle and never guesses.
- **A line received nothing while every health check passed.** Under Dopamine, SMServer without its Messages entitlements lists zero chats. Check that the chat list is not empty, not just that the server answers.
- **Sends said 200 but nothing arrived.** SMServer can report success for a failed send. The phone bridge checks the phone's own message list and reports `verified`.
- **A respring broke sends on a healthy phone.** SMServer's login session dies with SpringBoard. Restart that line's bridge after any respring.

## Backups

Back up `data/agent.sqlite` (conversations, reminders, bookings) and your `.env` and `lines/*.env` files, encrypted, somewhere other than the Mac. These files contain secrets and customer data; never commit them.
