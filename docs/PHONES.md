# iPhone lines

Each extra phone number is an old iPhone with a SIM, jailbroken, running [SMServer](https://github.com/iandwelker/smserver), sitting on a charger next to the Mac mini. The Mac runs one bridge per phone (`bridges/phone`).

Why bother, when the Mac has its own line? Apple limits how many new conversations one number can start without being flagged. In our production use, one line comfortably handled on the order of 50 new people a day and around 100 active people a day; past that we added lines. Treat those numbers as a rough guide, not a promise.

**This repository does not include any jailbreak tool or patched binary.** It links to the official projects. Always follow their current instructions for your exact model and iOS version; this page tells you what we learned living with these phones, not how the tools work internally.

- palera1n: [palera.in](https://palera.in), [source](https://github.com/palera1n/palera1n)
- Dopamine: [ellekit.space/dopamine](https://ellekit.space/dopamine/), [source](https://github.com/opa334/Dopamine)
- TrollStore: [source](https://github.com/opa334/TrollStore); TrollRestore: [source](https://github.com/JJTech0130/TrollRestore)
- checkra1n: [checkra.in](https://checkra.in)
- Step by step guides for all of the above: [ios.cfw.guide](https://ios.cfw.guide)
- SMServer: [source](https://github.com/iandwelker/smserver)

## Our recommendation

**Buy an iPhone 6s and jailbreak it through the Tips app** (TrollRestore puts a TrollStore installer into Apple's Tips app, TrollStore installs Dopamine, Dopamine jailbreaks). It is the best method we found: no computer or cable is needed after the first setup, and after a full reboot someone only has to open the Dopamine app and tap Jailbreak.

The iPhone 7 works the same way. The iPhone 8 also works, but on iOS 16.7.x the Tips route is not available, so it uses palera1n over USB instead and is more work to keep running.

## Buying a phone

1. **Model: iPhone 6s recommended; iPhone 7 and 8 also work.** These have the checkm8 boot ROM bug (A9 to A11 chips), which palera1n and checkra1n rely on, and they run iOS 15 or 16, where Dopamine and TrollStore work on many versions.
2. **The iOS version matters more than the model.** You cannot downgrade iOS, so whatever the phone ships on decides which jailbreak you live with. **Ask the seller the exact iOS version before you pay**, and check it is one the Tips route supports.
3. **What we ran, and how each felt to live with:**

| Phone | iOS | Jailbreak | After a full reboot | Verdict |
|---|---|---|---|---|
| iPhone 6s | 15.8.x | Tips app route: TrollStore, then Dopamine | Open the Dopamine app, tap Jailbreak. No cable. | **Recommended** |
| iPhone 7 | 15.8.x | Tips app route: TrollStore, then Dopamine | Same as above | Works just as well |
| iPhone 7 | 13.x | checkra1n (rootful) | USB re-jailbreak from a Mac | Worked, more upkeep |
| iPhone 8 | 16.7.x | palera1n (rootless) | USB re-jailbreak from a Mac, with DFU timing | Works, most upkeep |

On iOS 16.7.x the TrollStore route is not available (its support stops around 16.6.1 and the 16.7 release candidate), so an iPhone 8 on 16.7.x stays on palera1n. Check [ios.cfw.guide](https://ios.cfw.guide) for the current support ranges before you buy; they change.

**If you can choose, pick an iPhone 6s on an iOS 15 version that Dopamine supports.** A full reboot then needs only someone to tap a button on the phone, not a cable and a computer.

## SIM cards and iMessage activation

**Use a real, long-term SIM, not a temporary or throwaway one.** If you activate iMessage with a temporary SIM, Apple will most likely lock the number or Apple ID out of iMessage.

If that happens, contact Apple Support and ask them to unlock iMessage for the number. Explain that it is your business's number. In our experience this has always been accepted; it just costs you a call and some waiting. Then sign in again on the phone.

## Physical setup (once per phone)

Do these before anything else. Each one prevented a real outage.

- **Wall charger, 5 W or more.** A computer USB port is too weak: the phone slowly drains, powers off, and loses the jailbreak.
- **Settings, Display and Brightness, Auto-Lock: Never.** A sleeping phone drops Wi-Fi and the bridge sees it as down most of the time.
- **Automatic iOS updates: off.** An update reboots the phone (losing the jailbreak) and may make it permanently un-jailbreakable.
- **Low Power Mode: off.**
- **Give the phone a fixed LAN address** (a DHCP reservation on your router).
- **Network.** SMServer is run without TLS (`--no_secure`) and is protected only by its password. Put the phones on a network that only the Mac mini can reach: a separate VLAN or a dedicated access point. Never expose port 8741 to the internet.
- Sign in to iMessage with the phone number on the SIM and make sure iMessage is active in Settings, Messages.

## Jailbreaking

Follow the official guide for your exact model and iOS version on [ios.cfw.guide](https://ios.cfw.guide). Notes from our installs:

**The Tips app route: TrollStore and Dopamine (iOS 15, iPhone 6s or 7). Recommended.**
- Turn off Find My before you start; the TrollRestore step needs it.
- TrollRestore installs a TrollStore helper into a stock app (we used Tips). Open that app and choose to install TrollStore, then install the official Dopamine IPA with TrollStore. Keep TrollStore's persistence helper installed.
- Open Dopamine and tap Jailbreak. If it offers "Apply Workaround", apply it, let it restart the interface, then tap Jailbreak again.
- In Sileo (installed by Dopamine), set a mobile password and install **OpenSSH**, **ElleKit**, **PreferenceLoader** and **curl** from the default repositories.

**palera1n (iPhone 8 or X, iOS 16).**
- Use a rootless install. It is run from a Mac or Linux computer over USB.
- On A11 phones running iOS 16, palera1n requires the passcode to be off. Read palera1n's notes about this before you start.
- The DFU button timing is hard to do by hand on A11. What worked for us: run palera1n on the Mac with its screen in view and follow palera1n's own on-screen countdown helper.
- Every full reboot means plugging the phone into the Mac and running palera1n again.

**checkra1n (iOS 14 and older).** Rootful, semi-tethered: like palera1n, every full reboot needs a USB re-jailbreak.

## Installing SMServer

This is the least reproducible part of the whole stack. Budget time for it.

- SMServer's last upstream release (0.8.0) was built for **rootful** jailbreaks. Rootless jailbreaks (palera1n rootless, Dopamine) keep everything under `/var/jb`, so its tweak libraries need their load paths pointing there. A rootless build of 0.8.0 circulates in the community; we started from it.
- SMServer injects a tweak (`libsmserver.dylib`) that talks to Messages through `libmryipc`. Two copies of `libmryipc` loaded at once (the one bundled in `SMServer.app/Frameworks` and the one installed as a tweak dependency) crashed SMServer at launch with `MRYIPCException: Failed to lookup service port`. On our rootless phones the working set was a path-patched `libsmserver.dylib` plus `libmryipc` 2.0.1 in the tweak folder. Once one phone works, **copy its tweak folder to the next phone** instead of debugging from scratch: the same files worked across the 6s, 7 and 8.
- **Dopamine enforces the app sandbox.** Out of the box SMServer answers HTTP and even sends, but lists **zero chats**, so the line silently receives nothing. It has to be re-signed ad hoc with its original entitlements plus `com.apple.private.security.no-sandbox`, `com.apple.private.security.storage.Messages` and `com.apple.private.security.storage.MessagesMetaData`. Re-sign every Mach-O in the app (nested frameworks first, the main executable last) with `codesign --force --sign - --preserve-metadata=identifier,entitlements,requirements` plus the added entitlements, on a Mac, working on copies.
- **Dopamine also capped SMServer at 6 MB of memory**, so iOS kept killing it. `ios/smserver-launch.c` is a tiny launcher that raises the limit to 64 MB, drops to the mobile user, and starts SMServer. Build and install instructions are at the top of that file.
- **Run SMServer as a launchd daemon**, not by opening the app. Only the daemon (`--background --server_port 8741`) opens the HTTP port; the app icon does not. Template: `ios/smserver.plist.example`.
- On rootless phones SMServer reads its preferences from `/var/jb/var/mobile/Library/Preferences/com.ianwelker.smserver.plist`. Set `reload_on_network_change` to `NO` there: by default SMServer restarts its server on every Wi-Fi blip, which on iOS 15 crashed it several times a day. It reads the file at launch, so restart SMServer after changing it.

**Check it from the Mac:**

```bash
curl -m 6 -s http://PHONE_IP:8741/ | head -c 40                 # an HTML page: the server is up
curl -m 6 -s "http://PHONE_IP:8741/requests?password=PASSWORD"  # "true": the password works
curl -m 6 -s "http://PHONE_IP:8741/requests?chats=5"            # a JSON list of chats, not empty
```

The last check matters: an empty chat list with a healthy server is the Dopamine sandbox problem above.

## Optional: the phone tweak

SMServer handles text. Photos, native voice notes, reactions, app cards and GamePigeon games need a second add-on on the phone, the tweak in [ios/tweak/](../ios/tweak/README.md). It is the riskiest part of the stack (a bad build crashed phones during production rollout), so install it on a spare phone first and follow its README exactly. Without it, a line is text only.

## Connecting a line

1. Copy `lines/example.env` to `lines/phone1.env` (any line id), fill in the phone's address, SMServer password and a unique bridge port, and `chmod 600` it.
2. Add the line to `IMESSAGE_LINES` in `.env`, for example `phone1=http://127.0.0.1:3201`.
3. Start the bridge: `npm run bridge:phone -- lines/phone1.env`. On first start it records the newest message on the phone and ignores everything older.
4. Check it: `scripts/phone/check-line.sh PHONE_IP 3201`.
5. Text the phone's number from your own phone and watch the reply come back from it.

If the bridge logs `No route to host` but `curl` from a terminal works, set `SMSERVER_VIA_CURL=1` in the line file. We saw this with processes started by pm2 on macOS.

## When a line goes down

First, tell the two failure modes apart. Over SSH from the Mac:

```bash
ssh mobile@PHONE_IP 'uptime; test -e /var/jb && echo JB_PRESENT'
```

| What you see | What happened | Fix |
|---|---|---|
| SSH works, `JB_PRESENT`, uptime is long | The jailbreak is fine but tweaks stopped loading (usually SpringBoard crashed) | `scripts/phone/recover-line.sh mobile@PHONE_IP palera1n` (or `dopamine`). No cable. |
| SSH fails, or no `/var/jb`, or uptime is minutes | The phone fully rebooted and the jailbreak is gone | Re-jailbreak by hand: Dopamine app, or palera1n/checkra1n over USB. Then check SMServer is back. |
| Everything on the phone looks fine but every line fails at once | Not the phones: something on the Mac (for example a crashed process manager leaving old bridges holding their ports) | Look at the Mac first. Three phones never fail in lockstep on their own. |

After any recovery or respring, **restart that line's bridge**: SMServer's login session dies with SpringBoard, and the bridge will get errors until it logs in again.

### Hard rules

- **Never run the stock `launchctl reboot userspace`.** It restarts launchd without re-arming tweak injection; that is how one of our outages started. Use the jailbreak's own command (`p1ctl reboot-userspace` for palera1n, `jbctl reboot_userspace` for Dopamine), which is what `recover-line.sh` does.
- **Never run `reboot`** on a semi-tethered phone. The jailbreak is lost until someone re-jailbreaks it.
- **Never "fix" it with `killall SpringBoard`.** SpringBoard comes back without tweaks.
- **Never let two things act on one phone at once.** Our worst outage: an automatic recovery and a person recovering the same phone ran two userspace reboots twenty seconds apart, the phone fully rebooted, and the jailbreak was lost. That is why the watchdog here only alerts.
- **A flaky SSH connection looks exactly like a wrong password.** Retry before concluding anything.
- The phones' shell is zsh and the tools are minimal (`awk` and `pgrep` were missing on ours). Quote anything with brackets or a leading `=`.

### Routine maintenance

- **SMServer rots.** After one to two weeks of uptime iOS throttles it for CPU use: sends keep working but other things quietly stop. Restart just SMServer every few days at a quiet hour: `scripts/phone/restart-smserver.sh mobile@PHONE_IP`, then restart the line's bridge. Its launchd daemon brings it back in seconds; the jailbreak is untouched.
- Do not kill `cfprefsd` on a live phone. On one of ours it was followed by the tweak layer failing for half a day.
