# GamePigeon auto-play

People can send the agent a GamePigeon game in iMessage and it plays back on the same line: it reads the card, works out a move, plays a little worse or better than it could so the game stays fun, sends the move, and closes a finished game with "gg".

**Status, honestly:** ported from a production system where it played real games on jailbroken iPhone lines for months. Here it is unit tested (cipher, solvers, rubber band, difficulty, and the watcher's turn logic against a fake phone), but **it has not yet been run in this repo against a real phone.** Treat the first live run as a test: start with `GAMES_DRY_RUN=1`.

## Games

| Game | `game=` | Plays by default | Switch |
|---|---|---|---|
| Word Hunt | `hunt` | yes | always on |
| Anagrams | `anagrams` | no | `GP_ANAGRAMS_SEND=1` |
| Word Bites | `wordbites` | no | `GP_WORDBITES_SEND=1` |
| Darts | `darts` | no | `GP_DARTS_SEND=1` |
| Archery | `archery` | no | `GP_ARCHERY_SEND=1` |
| Basketball | `basketball` | no | `GP_BASKETBALL_SEND=1` |
| Cup Pong | `beer` | no | `GP_BEER_SEND=1` |
| Dots & Boxes | `dots` | no | `GP_DOTS_SEND=1` |
| Filler | `fill` | no | `GP_FILL_SEND=1` |
| Mini Golf | `golf` | no | `GP_MINIGOLF_SEND=1` and the golf engine (below) |
| 8 Ball | `pool` | no | `GP_POOL_SEND=1`, `GP_POOL_FORCE_ENABLE=1` and the pool engine (below) |
| Tanks | `tanks` | no | `GP_TANKS_SEND=1` (never verified on a real card; leave off) |

In production all of these except Tanks were live. They are off by default here because each one encodes a move format reverse-engineered from real cards, and a wrong card is visible to the person you are playing. Turn them on one at a time while you watch.

A game that is switched off, or one with no module at all (Chess, Checkers, Connect 4, Sea Battle and so on), gets one friendly "can't play that yet, send Darts or Mini Golf?" text per person per 30 minutes. The game name in that text comes from a fixed list, never from the card.

8 Ball never breaks: on a new game the bot sends the invite back so the person breaks on their own phone, then it answers simple shots it has simulated in the real physics engine.

## How it works

```
phone sms.db --/poc/read-games--> watcher --cipher--> play module --rubber band--> move
      ^                                                                            |
      +------------ /poc/send-balloon (payload re-archived by gp-archive) <--------+
```

1. **Read.** `games/watcher.ts` asks each line's on-phone tweak (`/poc/read-games`) for new inbound GamePigeon cards, oldest first, past a cursor kept in `data/games/line-<id>.json`. The first start skips every card already on the phone.
2. **Decode.** The card payload is a binary plist. `plutil` turns it into XML (under a hard file-size limit, since a forged plist can expand exponentially), the `data:?ver=52&data=...` URL is pulled out, and `cipher.ts` undoes GamePigeon's length-keyed shuffle into a flat `key=value` state.
3. **Decide.** The `game=` field picks a play module (`*-play.ts`). It solves the position (word games use a word list; aim games use ported physics) and asks the rubber band how strong to be.
4. **Send.** The new state is enciphered, `gp-archive` swaps it into a copy of the inbound card (keeping GamePigeon's layout and session), and the tweak sends it as a balloon threaded onto the game's first card, so the chat shows one game bubble. The watcher then waits for the phone to report the message delivered.
5. **Finish.** When a game ends the result is recorded for the rubber band and the person gets one closing text (`GAMES_FINISH_TEXT`, default `gg`) through the line's phone bridge.

### Never twice

- One poll per line at a time; cards are handled in row order.
- Once the phone accepts a move, that is written down before anything else. If the process dies after, the retry finishes the bookkeeping and does not send again.
- A card the bot already answered (its own id is on it, or the same board was just played) is ignored.
- A card that keeps failing holds the cursor and is retried; after `GAMES_MAX_ATTEMPTS` (3) it is dead-lettered, the cursor moves on, and Slack gets an alert. A card that crashes the process outright is caught the same way.
- Nothing is sent to anyone who texted STOP to the agent (read-only check of `DATABASE_PATH`).

### Difficulty (the rubber band)

`rubber-band.ts` keeps one strength factor per person per game, starting fair (1.0). A bot win eases it by 7%, a bot loss pushes it by 7%, inside 0.80 to 1.30, aiming at about a 50% win rate. Word games pick a human-looking set of words (many short, a few long) that sums to a target score; aim games turn the factor into an aim skill (`fair-play.ts`) that is never perfect. An abandoned word game is not counted as a bot win.

You can pin a level per person, for every game or for one:

```bash
node games/difficulty.ts +15550100001 chill          # chill | match | sweat | max | easier | harder | reset
node games/difficulty.ts +15550100001 "darts harder"
```

`max` is stored as `sweat` (a strong human, not an aimbot) and drops back to adaptive after two bot wins; `sweat` drops back after three bot losses. The watcher re-reads the file on every poll.

## Turning it on for a line

1. The line needs the on-phone tweak from `ios/tweak/` installed and answering (`/poc/ping`), with its shared secret.
2. On the Mac that runs the watcher:
   ```bash
   swiftc -O games/gp-archive.swift -o data/games/gp-archive     # Xcode command line tools
   ls /usr/share/dict/words                                       # the default word list
   ```
3. In `.env`:
   ```
   GAME_LINES=phone1=http://PHONE_IP:8799
   TWEAK_SECRET=...                 # or TWEAK_SECRET_PHONE1 per line
   ```
   `IMESSAGE_LINES` and `BRIDGE_KEY` (already set for the agent) are used to send the decline and "gg" texts through the line's phone bridge.
4. Dry run first, watch the log, then go live:
   ```bash
   GAMES_DRY_RUN=1 node games/watcher.ts
   node games/watcher.ts
   ```

| Variable | Default | Meaning |
|---|---|---|
| `GAME_LINES` | none | `line=tweak URL`, comma separated |
| `TWEAK_SECRET`, `TWEAK_SECRET_<LINE>` | none | the tweak's shared secret; a line without one is skipped |
| `GAMES_STATE_DIR` | `data/games` | cursors, rubber band, anchors, failures, outbox, the bot's player id |
| `GAMES_DICT_PATH` | `/usr/share/dict/words` | one word per line |
| `GP_ARCHIVE_PATH` | `data/games/gp-archive` | the compiled `gp-archive.swift` |
| `PLUTIL_PATH` | `/usr/bin/plutil` | |
| `GAMES_WASM_DIR` | `data/games/wasm` | Pool and Mini Golf engines (below) |
| `GAMES_DRY_RUN` | off | log moves instead of sending |
| `GAMES_POLL_MS` | 2500 | per line |
| `GAMES_MAX_ATTEMPTS` | 3 | before a card is dead-lettered |
| `GAMES_FINISH_TEXT` | `gg` | empty to send nothing at the end |
| `GAMES_PLAYER_AVATAR` | a plain avatar | GamePigeon avatar descriptor for the bot |
| `GP_<GAME>_SEND`, `GP_POOL_FORCE_ENABLE` | off | per-game switches (table above) |

Alerts use `ALERT_SLACK_WEBHOOK_URL`, like the line watchdog.

## Data that is not in this repo

- **Word list.** Production used the Mac's `/usr/share/dict/words` (about 235,000 words, 2.4 MB, ships with macOS). GamePigeon's own list is closer; point `GAMES_DICT_PATH` at any one-word-per-line file you are allowed to use.
- **Pool and Mini Golf engines.** These games simulate shots in GamePigeon's real physics, compiled to WebAssembly (`pool.wasm` about 85 KB, `golf.wasm` about 109 KB, plus Emscripten glue) from the AGPL-3.0 [OpenPigeon](https://github.com/OpenBubbles/openpigeon) C++ and a fork of Box2D. They are left out because their exact sources and build scripts were not part of this port, and shipping a binary without its corresponding source would not meet the AGPL. Build them with emcc and install as `GAMES_WASM_DIR/pool-glue.cjs` + `pool.wasm` and `golf-glue.cjs` + `golf.wasm` (rename emcc's `.js` glue to `.cjs`). Without them, 8 Ball and Mini Golf are declined politely.

Several engines (Filler, Tanks constants, the cipher) were written from OpenPigeon's source and real captured cards. OpenPigeon is AGPL-3.0, like this repo.

## Risks

- **It runs on the riskiest layer.** Reading sms.db and sending balloons goes through the injected tweak inside Messages on a jailbroken phone. If MobileSMS is suspended the reads fail for a while (the watcher retries quietly); a wedged tweak can stop games and other tweak features together.
- **GamePigeon is a third-party app.** Its card format, cipher, physics and the balloon bundle id were reverse-engineered. An update can change any of them; the usual symptom is the other phone saying "update GamePigeon" or showing a board that does not match. Every module skips a card it does not understand rather than guessing, but a format change still needs a code change.
- **A move can arrive late.** If the phone inserts a move but does not confirm delivery within about 15 seconds, the card is retried, as production did. If the first copy is delivered later the person sees a duplicate bubble.
- **Texts bypass the agent.** The decline and "gg" go straight to the line's phone bridge, not through the agent's reply router. They respect STOP, but not the agent's per-person reply cap or human handoff.

## What changed from production

- Plain TypeScript modules with typed imports, in place of the CommonJS factory and `require` injection the old build needed. Game logic is unchanged.
- The Mac `chat.db` path is gone: games are played only on iPhone lines, through the tweak client in `bridges/phone/tweak.ts`, with the payload sent inline (`payloadBase64`) instead of copied to the phone over SSH. The cold relaunch of the MobileSMS game listener over SSH is not wired in.
- Production told the main app about each game so the AI could react in its own voice; here a finished game gets a fixed closing text from a small durable outbox.
- Production let the AI change a person's difficulty when they asked; here it is the `games/difficulty.ts` command.
- Dropped: a pool data-capture mode tied to production's database, the heartbeat file for its monitor, a one-shot debug mode for the Mac path, and the file-based pool switch (`GP_POOL_FORCE_ENABLE` remains).
- Added: the STOP check, and Mini Golf is declined (not silently skipped) when its engine is missing.
