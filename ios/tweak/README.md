# The phone tweak (VanquelTweak)

SMServer sends plain texts well. It does not send native app cards or balloons, native voice notes or reliable tapbacks, and on rootless phones it silently drops photo attachments. This tweak fills those gaps. It runs inside SpringBoard on the jailbroken iPhone and listens on port **8799**. The phone bridge (`bridges/phone/tweak.ts`) talks to it when the line file sets `TWEAK_URL` and `TWEAK_SECRET`. Without those the bridge works as before, text only through SMServer.

**This is optional and the riskiest part of the stack.** Read the risks section before installing it on a phone that carries real customers.

## What it does

| Endpoint | What it sends or reads |
|---|---|
| `GET /poc/ping` | Health, no secret. Answers `pong host=SpringBoard im:ftc=1,pac=1,msg=1,reg=1,acc=1` (which IMCore classes loaded). |
| `POST /poc/send-photo` | One file (`filePath`) or several on ONE message (`filePaths`, pipe-separated, a stacked "3 Photos" bundle). `audio=1` sends a single file as a native voice note (waveform bubble). Answers `OK sent guid=... files=N`. |
| `POST /poc/send-text` | Plain text, including into an existing group by its `iMessage;+;chat...` guid (SMServer's own send fails for groups on iOS 16). |
| `POST /poc/send-card` | A native app card with an inline image: `bundleId`, `payloadFile` (archived MSMessage payload), `imageFile`, `breadcrumb`. |
| `POST /poc/send-balloon` | An imageless balloon, for example a GamePigeon move: `bundleId`, `payloadBase64` or `payloadFile`, optional `replyToGuid` (the move it updates in place). |
| `POST /poc/send-url-preview` | A rich link card with ordered favicon and hero images. |
| `POST /poc/send-poll` | A native iOS poll. |
| `POST /poc/send-tapback` | `to`, `guid`, `type` (love, like, dislike, laugh, emphasize, question). |
| `POST /poc/share-nickname` | Apple's Name and Photo Sharing for one chat (`dryRun=1` only checks). |
| `GET /poc/message-status?guid=` | `OK found=1 rowid=.. sent=.. delivered=.. error=.. attachments=N`, read from the phone's own sms.db. This is how the bridge proves a send left the phone and that all N files landed on one message. |
| `GET /poc/read-games?afterRowid=&limit=` | Inbound GamePigeon cards from sms.db as JSON `[{rowid, guid, chatGuid, bundleId, payloadB64}]`. |

Every endpoint except ping needs the shared secret in an `X-Tweak-Secret` header. The phone keeps it in `/var/mobile/.vanquel-tweak-secret`. If that file is missing or empty every request is refused (fail closed). Replies are plain text starting with `OK` or `ERR`. File paths in requests are paths **on the phone**: the bridge copies files there over `scp` first.

MobileSMS gets a second listener on **8800**, used only for GamePigeon sends: iOS 15 inserts a third-party balloon sent from SpringBoard but never transports it, and MobileSMS has the extension context that does. iOS suspends MobileSMS when idle, so that port is often closed; the bridge relaunches Messages over SSH when it needs it.

### Files

| File | What it is |
|---|---|
| `Tweak.m` | The tweak. Every private IMCore call is resolved at runtime and wrapped in `@try`. |
| `SmsDbRead.h` | The two read-only sms.db queries, shared with the helper. |
| `vanquel-smsdb.m`, `vanquel-smsdb.entitlements` | Dopamine only. Dopamine enforces the sandbox, so SpringBoard cannot open sms.db; the tweak runs this small helper, signed with the Messages storage entitlements, to do the two reads. |
| `Makefile`, `control`, `VanquelTweak.plist` | The Theos build, package metadata, and the injection filter (SpringBoard and MobileSMS). |
| `imcap/` | **IMCap, iOS 16 lines only.** Makes SpringBoard, MobileSMS and SMServer report the iMessage capability bits imagent wants (without it the tweak's sends fail on iOS 16; on iOS 13/15 libsmserver already does this), and forwards SMServer's typing indicator to SpringBoard, where it works on iOS 16. |
| `taskguard/` | **TaskGuard, rootless lines.** SMServer checks "am I running?" by spawning `ps` inside SpringBoard; under memory pressure that throws and crashes SpringBoard, and palera1n comes back in Safe Mode with every tweak off. TaskGuard catches the throw. Install it on any rootless line, tweak or not. |

## Risks: read before installing

- **It runs inside SpringBoard.** An uncaught exception or a crash in this code restarts the phone's home screen (a respring) and with it SMServer's session. A crash in the constructor could loop. The code is defensive for that reason: a trivial, deferred constructor, `@try` around every handler, and every IMCore send run on the main queue.
- **It crashed SpringBoard during the production rollout,** twice, both on iOS 16:
  1. IMCore's send asserts it runs on its own queue (`dispatch_assert_queue`). Called from the listener's thread it trapped, which `@try` cannot catch. Fixed by running every send on the main queue.
  2. The inline-image card path used the iOS 13 three-argument `_persistentPathForTransfer:filename:highQuality:`. iOS 16 removed it, the file was never staged into Messages' attachment store, and `sendMessage:` then faulted SpringBoard (after the message had already gone out). Fixed by trying the iOS 16 five-argument form and **refusing to send** when staging fails. If you port to a newer iOS, this is the first place to look.
- After that crash the line looked dead. The jailbreak was in fact intact: tweak injection had to be re-armed with the jailbreak's own userspace reboot (`scripts/phone/recover-line.sh`). Never "fix" it with a plain `killall SpringBoard`, `launchctl reboot userspace` or `reboot` (see [docs/PHONES.md](../../docs/PHONES.md#hard-rules)).
- **Validate on a spare phone first,** on the same model and iOS version as the line. Send each kind (photo, voice note, card, tapback) to your own phone before you point real traffic at it.
- Private Apple APIs change between iOS versions without notice. It was run on iOS 13.7 (checkra1n, rootful), iOS 15.8 (palera1n rootless and Dopamine) and iOS 16.7 (palera1n rootless). Anything else is untested.
- The listener has no TLS. Keep the phones on a network only the Mac can reach, exactly as for SMServer's port 8741, and use a long random secret.

## Build

On a Mac with Xcode, [Theos](https://theos.dev) and `ldid`:

```bash
export THEOS=~/theos
cd ios/tweak
make package FINALPACKAGE=1 SCHEME=rootless LINE_NUMBER=+15550100123
```

| Variable | Meaning |
|---|---|
| `THEOS` | Your Theos checkout. Required. |
| `LINE_NUMBER` | This line's own number, E.164. Required, no default: it is only the fallback creator handle of a native poll, but a wrong one would put another line's number in your messages. |
| `SCHEME` | `rootless` (palera1n rootless, Dopamine; installs under `/var/jb`) or `rootful` (checkra1n). Default `rootless`. |

## Install

`scripts/phone/install-tweak.sh` builds, installs and checks in one go, for one phone:

```bash
export PHONE_SSH=mobile@PHONE_IP JAILBREAK=dopamine   # or palera1n, rootful
export PHONE_SUDO_PASS='...'                          # the phone's sudo password; sent on stdin only
export LINE_NUMBER=+15550100123 THEOS=~/theos
export TWEAK_URL=http://PHONE_IP:8799 TWEAK_SECRET="$(openssl rand -hex 24)"

scripts/phone/install-tweak.sh taskguard   # rootless lines: do this first
scripts/phone/install-tweak.sh imcap       # iOS 16 lines only
scripts/phone/install-tweak.sh tweak
```

For `tweak` it saves the installed build on the phone under `/var/mobile/vanquel-tweak-backup/<time>/`, writes the secret file, installs (dpkg on rootless, a signed copy on rootful), restarts SpringBoard the way that jailbreak needs (`jbctl respring` on Dopamine, `p1ctl reboot-userspace` on palera1n, `killall -9 SpringBoard` on rootful checkra1n), and waits for the tweak to answer. If it does not answer, it puts the saved build back. On Dopamine it also installs the sms.db helper and checks it first.

Then put the same values in the line file and restart the line's bridge (a respring ends SMServer's login):

```
TWEAK_URL=http://PHONE_IP:8799
TWEAK_SECRET=<the same secret>
TWEAK_SSH=mobile@PHONE_IP
```

## Verify

```bash
curl -m 5 -s http://PHONE_IP:8799/poc/ping
# pong host=SpringBoard im:ftc=1,pac=1,msg=1,reg=1,acc=1

curl -m 8 -s -H @<(printf 'X-Tweak-Secret: %s\n' "$TWEAK_SECRET") "http://PHONE_IP:8799/poc/message-status?guid=selftest"
# OK found=0      (the secret works and sms.db is readable)

curl -s http://127.0.0.1:3201/health
# "tweak":"up"
```

Any `0` in the `im:` list means an IMCore class did not load in SpringBoard; card sends will refuse cleanly. `ERR sms.db not readable here and no helper` on Dopamine means the helper is missing. The tweak logs to `/tmp/vanquel-tweak.log` on the phone.

## Roll back

```bash
scripts/phone/install-tweak.sh rollback
```

This restores the newest backup from `/var/mobile/vanquel-tweak-backup/` (or removes the package if it was a first install) and restarts SpringBoard. If SpringBoard came back in Safe Mode or without tweaks, follow [docs/PHONES.md](../../docs/PHONES.md#when-a-line-goes-down) first. Removing `TWEAK_URL` from the line file and restarting the bridge turns every feature off from the Mac side without touching the phone.
