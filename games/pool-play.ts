// games/pool-play.ts
// =============================================================================
// GamePigeon 8-Ball auto-play (game=pool) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map + wordbites-play.ts):
//   game        : 'pool'
//   displayName : '8 Ball'
//   solve(state, deps) -> ctx | null (null => fail-safe skip)
//   decideMove(state, ctx, solve) -> { action, newState, mode, ... }
//
// It parses the `replay` field's ball blocks, plans a SIMPLE mid-game shot with the
// faithful real-physics engine (pool-real-engine.ts - GamePigeon's own Box2D pool
// transcribed to WASM), simulates it, and re-emits a replay whose POST is the
// engine's own true result (self-consistent with what the recipient's device
// re-animates).
//
// ============================ BREAK + RUN REBUILD (2026-07-09c) ================
// Pool used to emit a spin-blind 2D approximation whose POST diverged from the
// recipient's Box2D replay on ~100% of shots. The faithful WASM engine + the proven
// trust model (recipient FORCES object balls to our POST, RE-DERIVES only the cue +
// scratch, and RE-ANIMATES every shot from its header) let Bot now BREAK, POT, and
// RUN THE TABLE for real:
//
//   * BOT BREAKS - reproduces on-device (BUG-1 fix 2026-07-09c). On a fresh invite
//     Bot lays the standard rack and simulates a firm break (aim at the rack apex,
//     y=NEUTRAL_SPIN_Y) through the faithful engine IN THE SAME REGIME THE RECIPIENT
//     ANIMATES A RECEIVED BREAK: the ordinary first:false regime. It used to sim the
//     break with first:true (Box2D custom_slop 0.9 - the LIVE-break regime) and encode
//     that as the POST. But the recipient never applies the live-break flag to a
//     foreign replay: it re-animates the header in first:false, then snaps the balls to
//     our POST. first:true-scatter (encoded) vs first:false-scatter (animated) diverge
//     by ~150-550px, so the pretty break ended and every ball teleported (the tester: "as
//     soon as the replay ends the balls are in different spots"). Encoding the
//     first:false result makes the animation land EXACTLY on the forced POST -> zero
//     teleport. The break is deterministic (0.0px on re-sim) and the cue rests clear of
//     every pocket, so the tester never gets a phantom ball-in-hand. A clean no-pot break is
//     preferred (turn passes cleanly, table open); buildInvite is a last-resort
//     fallback. `decideMove` emits a real break card (kind:'break' -> play when armed).
//
//   * POT KEEPS THE TURN + CHAINS THE RUN (BUG-2 fix 2026-07-09c). A turn's card is a
//     RUN of K shots in ONE card, reverse-engineered from real multi-pot cards:
//         {h1}&balls:#PRE#|{h2}|{h3}|...|{hK}|balls:POST#&stripes:S[&win:1]
//     Each h is a shot header (&d&x&y&p&s); PRE is the board before shot 1, POST the
//     board after the last shot; per-segment `s` = the lock state at that shot; the tail
//     `&stripes:` = the final lock state. K=1 collapses to the old single-shot wire.
//     Bot used to emit exactly ONE shot per turn - so even when it POTTED it sent a
//     one-segment card and the turn passed to the tester ("if bot makes a shot he doesnt
//     keep going, he just ends his turn"). Now `planRun` chains: after each WASM-
//     confirmed legal pot it plans the next shot on the resulting table, and keeps
//     shooting while it keeps legally potting. The run ends on a legal MISS (turn
//     passes, no ball-in-hand) or a legal 8-pot WIN. So a legal pot CONTINUES the turn
//     (multiple segments animate as one run), exactly like a hand-played run.
//
//   * POT-FIRST SELECTION. Each shot in the run genuinely tries to SINK a ball: it
//     enumerates its legal target balls x pockets, seeds each with the ghost-ball
//     aim, sweeps a fine aim x firm-power grid through the real engine, and keeps the
//     aims the engine CONFIRMS drop the target with the cue left safe. It takes the
//     highest-confidence pot; only when NO pot is makeable does it fall back to a
//     sensible aimed legal shot (never a random hit). The encoded POST == the
//     engine's result, so the device's replay lands on it.
//
//   * SAFETY-MARGIN FILTER. The recipient FORCES object balls to the sent POST but
//     RE-DERIVES the cue + scratch from the shot params. The only desync risk is a
//     scratch verdict that flips between this engine and the real device (the
//     fork-vs-real residual). So Bot rejects any shot whose cue rests near a pocket
//     (knife-edge), keeping the scratch verdict robust to that residual. Object-ball
//     positions are exact (forced); a small cue-position residual is cosmetic and
//     self-heals on the next card Bot reads.
//
//   * FAIR-PLAY. Convergence to ~50% is honest and now rides on run LENGTH: as skill
//     drops (shared handicap factor via fair-play.ts) Bot increasingly DECLINES a
//     makeable pot - which also ENDS the run - and biases toward a harder pot when it
//     does shoot. The decline RAMPS over the run (2026-07-09e): shot 1 carries only
//     1/DECLINE_RAMP_SHOTS of MAX_DECLINE, full weight by shot 3, so a turn almost
//     always OPENS with a real attempt and the easing mass lands on the later shots
//     (no more god-mode/lobotomy coin-flip between turns). A declined pot emits an
//     engine-verified NEAR-MISS on a real pot line - the target ball rattles the
//     pocket - an honest miss that READS as a genuine attempt, never an aimless
//     smash. At max skill it runs longer (surest pot each shot). So a strong
//     table-runner naturally makes long runs and a weak one misses early; the
//     rubber-band tunes the factor to ~50% without ever faking a score.
//     Every segment of every run is a real, legal, on-felt, no-foul shot.
//
// SEND is gated by env GP_POOL_SEND + the watcher's poolArmed() sentinel. Pool is
// ARMED live (the tester is live-testing the real break + potting).
//
// ============================ TURN / FOUL ENCODING (2026-07-09) ================
// The recipient's device RE-DERIVES the cue + scratch/foul from the shot header
// (d,x,y,p,s), then FORCES the object balls to the POST block. So the header MUST be
// a shot the faithful engine calls LEGAL, encoded in the SAME regime the engine was
// validated in, or the device re-derives a phantom foul -> the tester wrongly gets
// ball-in-hand + the turn skips. Decoded from 34 real mid-game cards (two full
// hand-played reference games in chat.db):
//   * y (spinY) = 28.600000 on 100% of real mid-game cards - GamePigeon's neutral
//     follow-spin. Encoding y=0 (the old bug) runs the cue in an UNVALIDATED physics
//     regime -> re-derived foul on nearly every shot -> ball-in-hand every time.
//   * s / &stripes: are the TRI-STATE SUIT-OWNERSHIP LOCK (2026-07-09e, decoded
//     empirically from the tester's own cards - it is NOT a boolean): 0 = table open,
//     1 = PLAYER 1 owns stripes, 2 = PLAYER 2 owns stripes (the other player owns
//     solids). Each segment's s = the lock state ENTERING that shot; the tail
//     &stripes: = the FINAL lock state. The recipient's device trusts the inbound
//     tail VERBATIM and re-derives BOTH players' groups from it - stamping the wrong
//     value silently REASSIGNS the groups mid-game. (The old code collapsed the lock
//     to 0/1 and re-emitted every locked table as 1, which on the wire means
//     "player 1 [Bot] owns stripes" - so Bot stole stripes on the tester's screen even
//     after the tester potted a stripe first.) Once locked the value NEVER changes:
//     echo the inbound lock verbatim on every segment and the tail.
//   * &move: is a GamePigeon-internal replay hint with NO bearing on turn/foul logic
//     (it appears on a MINORITY of real turn-passing cards, uncorrelated with pots,
//     misses, or fouls). The turn passes to the opponent by DEFAULT on every card.
//     Hard-setting &move:1 on every shot (the old bug, cargo-culted from one break
//     capture) is wrong - we now emit NO &move, matching the majority clean card.
//   * A LEGAL shot (pot OR clean miss) => NO &o, turn passes, the tester shoots from where
//     the cue rests (no ball-in-hand). Bot only ever emits legal shots (selection
//     rejects any scratch / wrong-first-contact / off-suit-drop in sim), so it NEVER
//     grants the tester ball-in-hand - a real foul would, but Bot never sends one.
//
// VERIFIED WIRE ENCODINGS (a test line winner chain + two chat.db reference games):
//   * POTTED BALL = its 8-field entry is DROPPED from the block.
//   * f4 != 1 is COSMETIC render scale on the rack/break PRE block only; settled
//     post-shot blocks are f4=1.
//   * SUIT LOCK = replay tail `&stripes:` flips 0 -> the stripes-OWNER'S PLAYER
//     NUMBER (1 or 2) on the first legal pot after the break, then never changes.
//     Ownership comes from the lock value + each player's slot - NOT from counting
//     which group has more balls left (that guess flip-flops mid-game).
//   * BALL-IN-HAND = `&o:1` prefix (opponent fouled); WINNER = `&win:1` + top-level
//     `winner:` field.
// ============================================================================

import type { Ball, BallEntry, Point, RealBall, SimulationResult, FairPlay, PoolState, GameplayIdentity, PlayerIdentity, LegalOptions, RunOptions, SelectOptions, Suit, SolveContext, RunReplayOptions, SingleReplayOptions, Shot, Candidate, ResolvedShot, PotShot, NearMissShot, Selection, PlannedRun, Skipped, RunSegment } from './pool-types.ts';
import { poolEngine as engine } from './pool-engine.ts';
import { poolRealEngine as realEngine } from './pool-real-engine.ts';
import { rubberBand } from './rubber-band.ts';
import { fairPlay } from './fair-play.ts';

const rb = rubberBand as { handicapFactor(state: unknown): number };
const fair: FairPlay = fairPlay;
const enableSend = process.env.GP_POOL_SEND === '1';

const GAME_ID = 'pool';
const DISPLAY_NAME = '8 Ball';
const ENABLE_SEND = enableSend;

// Pre-warm the real engine at require time (fire-and-forget). The watcher requires
// this module at boot, so the WASM is instantiated long before any pool card is
// handled (and pool is gated off until armed anyway). decideMove skips safely if a
// card somehow arrives before the engine is ready.
realEngine.load().catch(() => { /* first simulateShot re-checks ready() */ });

function engineReady() {
    try { return realEngine.ready(); } catch (_) { return false; }
}

// -----------------------------------------------------------------------------
// SHOT CONSTANTS. Bot's mid-game selection PRIORITIZES POTTING: it enumerates its
// legal target balls x pockets, sweeps a fine aim x power grid through the faithful
// engine, and keeps the aims the engine CONFIRMS sink the target with the cue left
// safe. Only when no makeable+safe pot exists does it fall back to a sensible aimed
// LEGAL shot (never a random hit). Every shot encodes y=NEUTRAL_SPIN_Y - the
// validated wire regime on 100% of real mid-game cards.
// -----------------------------------------------------------------------------
const NEUTRAL_SPIN_Y = 28.6;            // GamePigeon's neutral follow-spin (wire y): on 100% of real mid-game cards
const CUE_PATH_POCKET_AVOID = 45;       // px - cue->contact segment must clear every pocket mouth
const MIN_CUE_POCKET_MARGIN = 80;       // px - cue must REST this far from any pocket (scratch-flip guard)
const MAX_DECLINE = 0.55;               // peak P(prefer a clean legal miss over a makeable pot) at max wildness
const DECLINE_RAMP_SHOTS = 3;           // decline is zero on shot 1 and reaches full MAX_DECLINE by shot 3
const RUN_MAX_SHOTS = 4;                // bound replay-chain divergence; long clears compound tiny device physics drift
// A simulated pot may only drive ANOTHER shot in the same replay when it is a
// boring, near-straight hanger and survives every wide perturbation probe. The
// recipient re-simulates intermediate shots instead of trusting our intermediate
// board; a marginal long/cut pot can miss there while later encoded shots still
// execute (the live "missed, then shot again" bug). Fail safe into an honest miss
// rather than chaining from a pot that exists only in our engine.
const POT_MIN_ROBUSTNESS = 0.85;        // at least 30/35 tolerance probes must still pot
const POT_CONTINUATION_MAX_CUT = 0.42;   // ~24 degrees: clean human cut, still far from a knife-edge
const POT_CONTINUATION_MAX_TP = 360;    // ordinary makeable pot, while excluding long hero shots
const WIN_POT_MAX_CUT = 0.60;            // the legal 8 deserves a wider finishing window (~34 degrees)
const WIN_POT_MAX_TP = 420;              // permit a normal long finish, still reject hero shots
// A winning 8 is the final and only replay segment, so it cannot trigger the
// dangerous "missed, then another encoded shot fired" failure. Keep a real
// tolerance floor, but do not require the continuation-grade 30/35 result.
const WIN_POT_MIN_ROBUSTNESS = 0.40;
const POT_ROBUSTNESS_AIM_OFFSETS = [0, -0.0035, 0.0035, -0.007, 0.007, -0.0105, 0.0105];
const POT_ROBUSTNESS_POWER_MULTIPLIERS = [0.98, 0.99, 1, 1.01, 1.02];

// NEAR-MISS (eased-miss quality fix, 2026-07-09e) - when fair-play declines a makeable
// pot (or no pot verifies but a real pot line exists), Bot emits an engine-verified
// NEAR-MISS on that line instead of an aimless full-ball smash: the ghost-ball aim is
// perturbed just OUTSIDE the pot window and simulated; kept only if it is legal, does
// NOT pot, leaves the cue safe, and the target ends within NEAR_MISS_RATTLE_PX of the
// intended pocket - a jaw rattle / lip-out a human reads as a genuine attempt.
const NEAR_MISS_OFFSETS = [0.008, -0.008, 0.011, -0.011, 0.015, -0.015, 0.022, -0.022,
    0.030, -0.030, 0.040, -0.040, 0.052, -0.052, 0.065, -0.065]; // rad off the ghost aim, smallest first
const NEAR_MISS_POWERS = [1100, 900, 1300, 700];    // pot-pace powers (a real attempt's pace), soft roll last
const NEAR_MISS_MAX_TP = 620;           // px target->pocket prefilter (looser than POT_MAX_TP so lines exist when pots don't)
const NEAR_MISS_RATTLE_PX = 140;        // px - a true jaw rattle: target ENDS this close to the intended pocket
const NEAR_MISS_LOOSE_PX = 200;         // px - fallback tier when no line rattles (still clearly pocket-bound)

// POT SEARCH - the ghost-ball aim for each legal (target, pocket) is only a SEED; the
// faithful engine is the judge. A fine aim sweep x firm power grid is simulated and
// the aim the engine confirms SINKS the target (cue safe, no scratch) is kept.
const POT_MAX_CUT = 0.95;               // rad (~54deg) - geometric prefilter; wider cuts are hopeless to seed
const POT_MAX_TP = 560;                 // px - target->pocket prefilter (a findable, not-hero-power pot)
const POT_POWERS = [900, 1100, 1300, 1500, 1700, 2000];  // firm wire powers swept per (target,pocket)
const POT_AIM_SWEEP = (() => { const a = []; for (let k = -6; k <= 6; k++) a.push(k * 0.008); return a; })(); // +-0.048 rad around the ghost aim
const WIN_POT_AIM_SWEEP = (() => { const a = []; for (let k = -16; k <= 16; k++) a.push(k * 0.004); return a; })();

// SAFE-FALLBACK (only when no makeable pot exists) - a firm straight LEGAL strike at
// a legal target, aimed sensibly (never random), verified legal + cue-safe in sim.
const SHOT_POWERS = [820, 1000, 640, 1180, 520];  // firm wire powers (0..2000), tried in this order
const EASY_POT_CUT = 0.42;              // rad (~24deg) - near-straight fallback pot aims only
const MAX_POT_TP = 320;                 // px - target->pocket ceiling for a fallback "easy" pot

// BALL-IN-HAND + FOUL (2026-07-10). Two directions, decoded from the tester's real `&o:1`
// cards (bJqd/U72 - a foul stamps `&o:1` and the opponent takes ball-in-hand):
//   * INBOUND: when the tester fouls (&o:1) or scratches (cue off-table / missing), Bot
//     may place the cue anywhere legal. It sets up the easiest STRAIGHT pot on its own
//     group (cue set back behind the ghost on the target->pocket line), verified in
//     sim; failing that, a safe default spot. This is the visible "next player moves
//     the ball" behavior the tester expected. Bot only repositions on a REAL foul signal.
//   * OUTBOUND: when Bot itself has NO legal shot (snookered), it plays a real forced
//     contact shot instead of STALLING (the old skip left the game hung). If the sim
//     confirms a genuine foul (wrong ball reachable first), it stamps `&o:1` so the tester
//     gets ball-in-hand; a clean legal miss never stamps `&o` (real-foul-only).
const IN_HAND_PULLBACKS = [150, 120, 190, 100, 230]; // px cue set-back behind the ghost for a straight in-hand pot
const IN_HAND_POWERS = [1100, 900, 1300];            // pot-pace powers for the in-hand straight pot
const FORCED_POWERS = [520, 700, 900];               // gentle contact powers for a no-legal-shot forced shot
const DEFAULT_CUE_SPOTS = [[392, 220], [300, 220], [490, 220], [392, 300], [392, 140], [230, 220], [560, 220]]; // fallback ball-in-hand spots

// STANDARD RACK + BREAK. When Bot receives a fresh 8-Ball invite it BREAKS (no more
// re-invite): it lays the standard rack, simulates a firm break through the faithful
// engine, and encodes the one whose cue rests in a safe center zone. Rack geometry +
// break spot are byte-patterned on the real num=2 break PRE block.
const RACK_SLOTS = [
    // [x, y] - the 15 object-ball positions, apex-first (rack sits on the right)
    [560.0, 220.0],                                   // apex
    [578.186523, 209.5], [578.186523, 230.5],         // row 2
    [596.373047, 199.0], [596.373047, 220.0], [596.373047, 241.0], // row 3 (center = 8-ball slot)
    [614.559570, 188.5], [614.559570, 209.5], [614.559570, 230.5], [614.559570, 251.5], // row 4
    [632.746155, 178.0], [632.746155, 199.0], [632.746155, 220.0], [632.746155, 241.0], [632.746155, 262.0], // back row
];
const RACK_CENTER_INDEX = 4;            // (596.373,220) - the 8-ball MUST sit here
const CUE_BREAK_SPOT = [198.033707, 379.899994]; // cue break spot from the capture
const BREAK_AIM = -0.337726;            // validated capture break aim (cue break spot -> rack apex)
const BREAK_POWERS = [2000, 1500, 1100, 900, 700]; // descending - a firm realistic scatter first

// -----------------------------------------------------------------------------
// parseReplay(replay) - split "&d:..&x:..&balls:#..#|balls:..#&stripes:..[&move:..]"
// Returns { d,x,y,p,s, pre:[entry], post:[entry], stripes, move } or null.
// Each entry: { x,y,f3,f4,n,r1,r2,r3, raw:[8 strings] }.
// -----------------------------------------------------------------------------
function parseBallBlock(block: string) {
    const parts = block.split('#').map((s) => s.trim()).filter((s) => s.length > 0);
    const out = [];
    for (const p of parts) {
        const f = p.split(',');
        if (f.length !== 8) return null;
        out.push({
            x: parseFloat(f[0]), y: parseFloat(f[1]), f3: parseFloat(f[2]), f4: parseFloat(f[3]),
            n: parseInt(f[4], 10), r1: parseFloat(f[5]), r2: parseFloat(f[6]), r3: parseFloat(f[7]),
            raw: f,
        });
    }
    return out;
}

function parseReplay(replay: unknown) {
    if (typeof replay !== 'string' || replay.indexOf('balls:') < 0) return null;
    const get = (key: string) => {
        const m = replay.match(new RegExp('&' + key + ':(-?[0-9.]+)'));
        return m ? parseFloat(m[1]) : null;
    };
    const d = get('d'), x = get('x'), y = get('y'), p = get('p');
    const sM = replay.match(/&s:(-?\d+)/); const s = sM ? parseInt(sM[1], 10) : null;
    const stripesM = replay.match(/&stripes:(-?\d+)/); const stripes = stripesM ? parseInt(stripesM[1], 10) : null;
    const moveM = replay.match(/&move:(-?\d+)/); const move = moveM ? parseInt(moveM[1], 10) : null;
    const ballInHand = /&o:1/.test(replay) ? 1 : null;
    const win = /&win:1/.test(replay) ? 1 : null;

    const ballsIdx = replay.indexOf('&balls:');
    if (ballsIdx < 0) return null;
    let rest = replay.slice(ballsIdx + '&balls:'.length);
    const stripesIdx = rest.indexOf('&stripes:');
    if (stripesIdx >= 0) rest = rest.slice(0, stripesIdx);
    // An opponent's turn card may be a K-segment RUN (a multi-pot turn):
    //     PRE|{hdr2}|{hdr3}|...|balls:POST
    // PRE is the FIRST pipe-delimited block; POST is the FINAL `|balls:` block; the bare
    // `&d&x&y&p&s` headers in between are intermediate shots (no ball block - the device
    // re-derives them). Bot only needs the resulting POST table + the tail stripes, so
    // split PRE off at the first pipe and POST off at the last `|balls:`. K=1 collapses to
    // the single-shot wire. (Before this fix Bot mis-parsed multi-pot inbound cards and
    // silently skipped the tester's whole turn.)
    const postIdx = rest.lastIndexOf('|balls:');
    if (postIdx < 0) return null;
    const postBlock = rest.slice(postIdx + '|balls:'.length);
    const firstPipe = rest.indexOf('|');
    const preBlock = rest.slice(0, firstPipe >= 0 ? firstPipe : postIdx);
    const pre = parseBallBlock(preBlock);
    const post = parseBallBlock(postBlock);
    if (!pre || !post) return null;
    return { d, x, y, p, s, pre, post, stripes, move, ballInHand, win };
}

// -----------------------------------------------------------------------------
// entriesToBalls(entries) - parsed entries -> ball objects carrying cosmetics.
// A junk off-table coordinate (GamePigeon's "flung into a pocket" placeholder for a
// potted ball) is marked onTable:false so it is never simulated nor re-emitted.
// -----------------------------------------------------------------------------
function entriesToBalls(entries: BallEntry[]): Ball[] {
    return entries.map((e) => ({
        n: e.n, x: e.x, y: e.y, f3: e.f3, f4: e.f4, r1: e.r1, r2: e.r2, r3: e.r3,
        onTable: !engine.isOffTable(e.x, e.y),
    }));
}

function fmt(n: number) { return Number(n).toFixed(6); }

// q6(n) - quantize to the 6dp WIRE precision (exactly what fmt() encodes). Planning
// sims run at this precision - aim d is quantized at candidate build, and the board
// re-quantizes per hop in planRun - so the recipient's re-animation of the rounded
// wire headers lands on the exact POST we computed. Full-precision planning used to
// diverge from the rounded wire on knife-edge shots (a "potted" ball snapping back
// out of the pocket when the real device re-animated the 6dp header).
function q6(n: number) { return Number(Number(n).toFixed(6)); }

// -----------------------------------------------------------------------------
// ballToEntry(b) - ball -> "x,y,f3,f4,n,r1,r2,r3" (8 fields, 6dp floats).
// -----------------------------------------------------------------------------
function ballToEntry(b: Ball) {
    return [fmt(b.x), fmt(b.y), fmt(b.f3 || 0), fmt(b.f4 == null ? 1 : b.f4),
        String(b.n), fmt(b.r1 || 0), fmt(b.r2 || 0), fmt(b.r3 || 0)].join(',');
}

function onTableOnly(balls: Ball[]) {
    return balls.filter((b) => b.onTable !== false);
}

// -----------------------------------------------------------------------------
// buildRunReplay({ segments, pre, post, stripes, ballInHand, win }) - re-emit a whole
// TURN as one multi-segment RUN card, byte-patterned on real GamePigeon multi-pot
// cards (decoded from chat.db):
//     {h1}&balls:#PRE#|{h2}|{h3}|...|{hK}|balls:POST#&stripes:S[&win:1]
// `segments` = [{ d,x,y,p,s }, ...] in shot order (K>=1). Each header carries THAT
// shot's lock state s; the tail `&stripes:` carries the FINAL lock state. `pre` is the
// board BEFORE shot 1; `post` the board AFTER the final shot. Potted balls
// (onTable === false, or dropped from `post`) are filtered out of both blocks so the
// post block shrinks exactly as GamePigeon's does. `p` per segment is the WIRE power
// (0..2000). NO `&move` is ever emitted - it is a GamePigeon-internal replay hint with
// no turn/foul meaning (see the TURN / FOUL ENCODING block at the top of this file).
// `&o:1` (ballInHand) is emitted ONLY on a genuine foul; Bot never sends a foul, so it
// stays absent. K=1 collapses to the proven single-shot wire.
// -----------------------------------------------------------------------------
function segHeader(h: Shot) {
    return `&d:${fmt(h.d)}&x:${fmt(h.x)}&y:${fmt(h.y)}&p:${fmt(h.p)}&s:${h.s}`;
}

function buildRunReplay({ segments, pre, post, stripes, ballInHand, win }: RunReplayOptions) {
    const preStr = '#' + onTableOnly(pre).map(ballToEntry).join('#') + '#';
    const postStr = onTableOnly(post).map(ballToEntry).join('#') + '#';
    const first = (ballInHand ? '&o:1' : '') + segHeader(segments[0]);
    let mid = '';
    for (let i = 1; i < segments.length; i++) mid += '|' + segHeader(segments[i]);
    let out = `${first}&balls:${preStr}${mid}|balls:${postStr}&stripes:${stripes}`;
    if (win) out += '&win:1';
    return out;
}

// buildReplay(...) - single-shot (K=1) convenience wrapper over buildRunReplay. Kept
// for the break card, the fallback path, and the dry-run tests.
function buildReplay({ d, x, y, p, s, pre, post, stripes, ballInHand, win }: SingleReplayOptions) {
    return buildRunReplay({ segments: [{ d, x, y, p, s }], pre, post, stripes, ballInHand, win });
}

// -----------------------------------------------------------------------------
// SUIT GROUPS. solids = 1..7, stripes = 9..15, the 8 is neutral. Ownership is
// derived from group membership once `&stripes:` locks to 1 (no explicit field).
// -----------------------------------------------------------------------------
const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
const STRIPES = [9, 10, 11, 12, 13, 14, 15];

function suitTargets(suit: Suit, onTable: Set<number>) {
    const group = suit === 'stripes' ? STRIPES : SOLIDS;
    const objs = group.filter((n) => onTable.has(n));
    if (objs.length === 0 && onTable.has(8)) return [8];
    return objs;
}

// legalTargetsFor(balls, opts) - which ball numbers Bot may hit first.
function legalTargetsFor(balls: Ball[], opts?: LegalOptions) {
    opts = opts || {};
    const onTable = new Set(balls.filter((b) => b.onTable).map((b) => b.n));
    if (opts.stripes === 1 && opts.botSuit) {
        return suitTargets(opts.botSuit, onTable);
    }
    const objs = [];
    for (let n = 1; n <= 15; n++) if (n !== 8 && onTable.has(n)) objs.push(n);
    if (objs.length === 0 && onTable.has(8)) return [8];
    return objs;
}

function looksLikePool(state: PoolState | null | undefined): state is PoolState {
    return !!(state && state.game === GAME_ID);
}

// -----------------------------------------------------------------------------
// solve(state, deps) - returns a parse context, or null (=> fail-safe skip).
//   Fresh invite (no replay): ctx.kind='break' (Bot would be the breaker).
//   Gameplay card (has replay): ctx.kind='shot' with parsed blocks.
// -----------------------------------------------------------------------------
function solve(state: PoolState | null | undefined, _deps?: unknown): SolveContext | null {
    if (!looksLikePool(state)) return null;
    if (state.winner) return { kind: 'finished' };
    if (!state.replay) {
        return { kind: 'break', seed: state.seed };
    }
    const parsed = parseReplay(state.replay);
    if (!parsed) return null;
    return { kind: 'shot', parsed };
}

// -----------------------------------------------------------------------------
// safetyCheck(entries) - reasons the card is genuinely MALFORMED (unreadable).
// -----------------------------------------------------------------------------
function safetyCheck(entries: Ball[] | null | undefined) {
    if (!entries || entries.length === 0) return 'ball block empty or unparseable';
    if (entries.length > 16) return 'ball block has ' + entries.length + ' entries (>16) - corrupt';
    const nums = entries.map((e) => e.n);
    const seen = new Set<number>();
    for (const n of nums) {
        if (n == null || Number.isNaN(n) || n < 0 || n > 15) return 'ball number ' + n + ' out of range 0..15 - corrupt';
        if (seen.has(n)) return 'duplicate ball number ' + n + ' - corrupt';
        seen.add(n);
    }
    if (!seen.has(0)) return 'cue ball (0) missing from block - cannot shoot';
    return null;
}

// -----------------------------------------------------------------------------
// botSlot(state, botUuid) - which player number Bot occupies (1 or 2).
// -----------------------------------------------------------------------------
function botSlot(state: PoolState, botUuid?: string | null) {
    if (botUuid && state.player1 === botUuid) return { player: 1, opponent: 2 };
    if (botUuid && state.player2 === botUuid) return { player: 2, opponent: 1 };
    if (state.player1 && state.player1 !== botUuid) return { player: 2, opponent: 1 };
    if (state.player2 && state.player2 !== botUuid) return { player: 1, opponent: 2 };
    const inviter = Number(state.player);
    if (inviter === 1) return { player: 2, opponent: 1 };
    if (inviter === 2) return { player: 1, opponent: 2 };
    return { player: 2, opponent: 1 };
}

// -----------------------------------------------------------------------------
// poolGameplayState(state, {...}) - convert a card into the TRUE pool gameplay
// generation before re-emitting a MID-GAME shot (version=5, no invite markers,
// incremented num, Bot's slot stamped).
// -----------------------------------------------------------------------------
function poolGameplayState(state: PoolState, { player, botUuid, botAvatar }: GameplayIdentity) {
    const next: PoolState = { ...state };
    delete next.start;
    delete next.game_name;
    delete next.caption;
    next.version = '5';
    next.tver = '5';
    next.player = String(player);
    next.num = state.num ? String(Number(state.num) + 1) : '2';
    if (botUuid) {
        next.sender = botUuid;
        next['player' + player] = botUuid;
        if (botAvatar) next['avatar' + player] = botAvatar;
    }
    return next;
}

// -----------------------------------------------------------------------------
// buildInvite(state, {...}) - YOU-BREAK. Flip an inbound 8-Ball invite into a
// FRESH invite SENT BY BOT so the tester becomes the recipient who breaks natively.
// Keeps the invite markers (start/game_name/caption/version=5), re-stamps the
// sender + Bot's slot, drops any replay/winner, and mints a NEW session id so the
// recipient's GamePigeon treats it as a brand-new game (not a threaded reply, which
// would make GamePigeon think BOT broke). The watcher archives this with the
// gp-archive `new` session mode and sends it un-threaded.
// -----------------------------------------------------------------------------
function newSessionId() {
    // 16 base62 chars - the shape GamePigeon session ids take.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
}

function buildInvite(state: PoolState, { botUuid, botAvatar }: PlayerIdentity) {
    const { player } = botSlot(state, botUuid);
    const next: PoolState = { ...state };
    delete next.replay;
    delete next.winner;
    next.version = '5';
    next.tver = '5';
    next.num = '1';
    next.id = newSessionId();               // NEW game session (the tester breaks)
    next.player = String(player);           // Bot is the inviter
    if (botUuid) {
        next.sender = botUuid;
        next['player' + player] = botUuid;
        if (botAvatar) next['avatar' + player] = botAvatar;
    }
    if (!next.caption) next.caption = "Let's play 8 Ball!";
    if (!next.game_name) next.game_name = '8 Ball';
    return next;
}

// -----------------------------------------------------------------------------
// standardRack(seed) - the break PRE block: 15 object balls racked + cue at the
// break spot. The 8-ball is fixed at rack center; the other 14 labels shuffle
// deterministically on `seed` (positions are seed-independent). Cosmetic r1..r3 get
// plausible small values; f4=1 (settled scale). Returns full ball objects.
// -----------------------------------------------------------------------------
function standardRack(seed: unknown): Ball[] {
    const others = [];
    for (let n = 1; n <= 15; n++) if (n !== 8) others.push(n);
    let st = (Number(seed) || 12345) >>> 0;
    const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
    for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
    }
    const balls = [];
    let oi = 0;
    for (let slot = 0; slot < RACK_SLOTS.length; slot++) {
        const [sx, sy] = RACK_SLOTS[slot];
        const n = slot === RACK_CENTER_INDEX ? 8 : others[oi++];
        balls.push({ n, x: sx, y: sy, f3: 0, f4: 1,
            r1: (rnd() * 12 - 6), r2: (rnd() * 12 - 6), r3: (rnd() * 12 - 6), onTable: true });
    }
    balls.push({ n: 0, x: CUE_BREAK_SPOT[0], y: CUE_BREAK_SPOT[1], f3: 0, f4: 1,
        r1: (rnd() * 12 - 6), r2: (rnd() * 12 - 6), r3: (rnd() * 12 - 6), onTable: true });
    return balls;
}

// -----------------------------------------------------------------------------
// REAL CAPTURED BREAKS (BUG-1 ROBUST FIX, 2026-07-09d). The faithful WASM engine is
// an imperfect transcription of GamePigeon's Box2D: an independent verify measured
// its first:false break scatter diverging 62-430px from the REAL iPhone's own break
// physics (checked against the tester's real chat.db breaks). The recipient re-animates
// Bot's header with ITS OWN physics, so a WASM-computed break POST lands tens-to-
// hundreds of px off where the phone animates the header, then snaps -> a residual
// teleport the WASM harness literally cannot see (its "phone model" IS the WASM the
// real phone disagrees with).
//
// So the break scatter is NO LONGER computed with the WASM at all. Bot REPLAYS A REAL
// The tester iPHONE BREAK, verbatim. GamePigeon replays are deterministic on-device (every
// multiplayer game would desync otherwise), so when the tester's phone receives a card
// carrying a header HIS OWN phone originally generated, it re-animates that header and
// reproduces the SAME scatter it produced the first time -- which is exactly the POST
// we send. Animation == snapped POST => provably zero teleport, whether the device
// forces the object balls to POST (the measured behavior) or re-simulates them (the
// verify's concern): either way the phone's own physics on its own header yields the
// captured POST. The WASM never touches the break, so its fidelity gap is irrelevant.
//
// Each entry's replay is the EXACT wire string GamePigeon packed into the tester's break
// card (verbatim -- it already round-tripped through the cipher when he sent it, so it
// re-encodes cleanly). Harvest criteria (production research notes): a game BOT
// invited + the tester broke (is_from_me=0 on the Mac line, i.e. produced by the tester's own
// phone -> guaranteed to reproduce on it); pots NOTHING (clean turn-pass, table stays
// open, no run to chain off the break); cue rests on felt >= MIN_CUE_POCKET_MARGIN from
// every pocket (no phantom ball-in-hand); standard rack PRE. Byte-identity of every
// entry against its real chat.db card was asserted by a production check (not included).
// -----------------------------------------------------------------------------
const REAL_BREAKS = [
    // Game xcCbkqCZlWzsNF2I, chat.db rowid 33137 - the tester's OWN iPhone break
    // (is_from_me=0). Header d=0 (straight at the rack apex), x=0, y=28.6 neutral
    // spin, p=997.115479, s=0; cue breaks from (220,220) and rests at (515.2,224.4),
    // ~248px from any pocket; pots nothing; all 16 balls come to rest on felt. The
    // recipient (the tester's phone) re-animates this exact header and lands on this exact
    // POST -> zero teleport.
    {
        id: 'xcCbkqCZlWzsNF2I', rowid: 33137, source: 'tester-iphone (is_from_me=0)',
        replay: '&d:0.000000&x:0.000000&y:28.600000&p:997.115479&s:0&balls:#632.746155,178.000000,0.000000,0.977383,5,-5.160658,6.524427,7.626123#632.746155,199.000000,0.000000,0.050000,11,-5.217432,-3.898319,-1.994702#632.746155,220.000000,0.000000,0.247753,15,-6.072986,-2.044601,-7.280642#632.746155,241.000000,0.000000,0.050000,12,6.114585,4.146367,-1.389488#632.746155,262.000000,0.000000,1.076553,9,-7.499710,7.780226,6.959055#614.559570,188.500000,0.000000,0.993326,6,-6.726971,1.092494,-5.372702#614.559570,209.500000,0.000000,0.970864,7,4.290236,5.307253,6.245793#614.559570,230.500000,0.000000,0.879821,1,0.227302,1.227135,-3.428239#614.559570,251.500000,0.000000,1.159662,3,6.842705,-1.275312,-0.093962#596.373047,199.000000,0.000000,1.022328,13,3.724455,-7.350520,-6.288323#596.373047,220.000000,0.000000,1.002283,8,-4.038508,3.903940,-7.270927#596.373047,241.000000,0.000000,1.090095,14,0.554335,0.687360,0.708721#578.186523,209.500000,0.000000,0.900000,2,-6.709996,-0.481892,4.913014#578.186523,230.500000,0.000000,1.100000,10,-6.731904,4.647582,-4.802827#560.000000,220.000000,0.000000,1.000000,4,6.788603,-0.861026,3.713466#220.000000,220.000000,0.000000,0.990000,0,1.199676,7.946198,-6.198325|balls:191.498810,191.470566,48.260944,1.000000,5,-19.843817,10.389915,-15.615981#682.550598,103.058784,1.304703,1.000000,11,-174.618454,-125.265648,-61.191158#677.782410,218.078476,0.161316,1.000000,15,-134.971130,5.190363,-9.114529#681.390625,352.056671,-2.567949,1.000000,12,-151.358871,134.388336,44.565174#233.087784,246.950607,-50.192333,1.000000,9,-118.898773,-13.233387,68.333473#613.048157,144.999268,0.412643,1.000000,6,13.003793,127.414581,-5.989528#666.763062,167.763596,-0.176694,1.000000,7,-162.693634,115.588356,7.782608#657.430725,262.726288,0.377467,1.000000,1,-129.988953,-91.621300,1.633865#629.970581,324.379578,-0.270816,1.000000,3,-45.718403,-213.445892,-13.455721#563.611694,128.891861,1.608041,1.000000,13,83.703568,201.832748,55.894283#596.373047,220.000000,0.000000,1.000000,8,-4.038508,3.903940,-7.270927#572.617188,287.751801,-0.466718,1.000000,14,75.083908,-137.838516,-14.712975#525.796021,124.346634,0.556342,1.000000,2,217.752258,123.952156,-140.939651#507.977081,303.433533,-0.609379,1.000000,10,255.458221,-81.148926,91.007637#520.602295,192.666031,-1.661207,1.000000,4,136.377258,87.030312,-4.245676#515.237915,224.408157,0.000000,1.000000,0,-133.950684,13.167727,22.470333#&stripes:0',
    },
];

// -----------------------------------------------------------------------------
// pickRealBreak(stateId) - deterministically pick a captured break for this game.
// Rotates over REAL_BREAKS by a stable FNV-1a hash of the game id, so a given game
// always replays the same break (idempotent re-reads) while different games vary. No
// Math.random. Empty library => null (caller falls back to the WASM break, then to a
// YOU-BREAK re-invite).
// -----------------------------------------------------------------------------
function pickRealBreak(stateId: unknown) {
    if (!REAL_BREAKS.length) return null;
    const key = String(stateId || '');
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return REAL_BREAKS[(h >>> 0) % REAL_BREAKS.length];
}

// -----------------------------------------------------------------------------
// buildBreakThroughEngine(seed) - BOT BREAKS, reproducibly (BUG-1 fix). Simulate a
// firm break (aim at the rack apex, y=NEUTRAL_SPIN_Y) through the faithful engine at
// descending powers and take the first whose cue rests in a SAFE center zone.
//
// CRITICAL: sim the break in the SAME regime the recipient ANIMATES a received break -
// the ordinary first:false regime - and encode THAT as the POST. The recipient FORCES
// the object balls to our POST AND re-animates the header; but it re-animates in
// first:false (it never applies the live-break flag `first:true`/custom_slop 0.9 to a
// foreign replay). Encoding a first:true POST (the old bug) made the pretty first:false
// break animation snap to a first:true scatter that differed by ~150-550px - the
// teleport the tester saw. A first:false POST lands the animation exactly on the forced POST.
// The engine is deterministic (0.0px on re-sim of the same header), so the phone's
// first:false re-sim reproduces our POST bit-for-bit.
//
// The cue must rest cleanly (not potted, no scratch, >= MIN_CUE_POCKET_MARGIN from every
// pocket) so the re-derived scratch verdict can't flip to a phantom ball-in-hand. Prefer
// a break that pots nothing (clean turn-pass, table stays open); a legal potted break is
// kept only as a fallback.
// Returns { preBalls, post, real, p, potted } or null (caller re-invites instead).
// -----------------------------------------------------------------------------
function buildBreakThroughEngine(seed: unknown) {
    const preBalls = standardRack(seed);
    const realIn = toRealInput(preBalls);
    let fallback = null;
    for (const p of BREAK_POWERS) {
        const shot = { d: BREAK_AIM, x: 0, y: NEUTRAL_SPIN_Y, p, s: 0 };
        const rf = realEngine.simulateShot(realIn, shot, { first: false });
        if (rf.cueSunk || rf.cue.potted || rf.firstHit == null) continue;   // scratch / no rack contact
        if (nearestPocketDist(rf.cue.x, rf.cue.y) < MIN_CUE_POCKET_MARGIN) continue;
        const { post, oob } = buildPostFromReal(preBalls, rf);
        if (oob.length || validateCardReal(post)) continue;                 // off-felt / unplayable POST
        const potted = rf.potted.map((x) => x.n).filter((n) => n !== 0);
        const cand = { preBalls, post, real: rf, p, potted };
        if (potted.length === 0) return cand;   // clean pots-nothing safe break - take the firmest
        if (!fallback) fallback = cand;         // a legal potted break, kept as fallback
    }
    return fallback;
}

// =============================================================================
// POT-FIRST SHOT SELECTION (the real-physics core). Bot genuinely tries to SINK a
// ball. It enumerates its legal target balls x pockets, seeds each with the ghost-
// ball aim, then sweeps a fine aim x firm-power grid through the faithful engine and
// keeps the aims the engine CONFIRMS drop the target with the cue left safe (no
// scratch, resting clear of pockets). The highest-confidence pot is taken (fair-play
// eases to a harder pot or an honest legal miss as skill drops). Only when NO pot is
// makeable does Bot fall back to a sensible aimed LEGAL shot - never a random hit.
// Every emitted shot is legal in sim (no scratch, legal ball hit FIRST, no off-suit/
// early-8 drop, cue clear of pockets), so it passes the turn to the tester with NO ball-
// in-hand; Bot never emits a foul. If nothing legal exists at all, Bot skips.
// =============================================================================

// toRealInput(preBalls) - on-table balls -> the engine's ball input (cue is n=0).
function toRealInput(preBalls: Ball[]): RealBall[] {
    return preBalls.filter((b) => b.onTable !== false)
        .map((b) => ({ n: b.n, x: b.x, y: b.y, rot: 0, density: 1 }));
}

function nearestPocketDist(x: number | null, y: number | null) {
    let m = Infinity;
    for (const pk of engine.POCKETS) m = Math.min(m, Math.hypot(Number(x) - pk.x, Number(y) - pk.y));
    return m;
}

// cuePathClearOfPockets(cue, gx, gy) - the cue's travel segment to the contact point
// must not pass over a pocket mouth (an en-route scratch the device would animate).
function cuePathClearOfPockets(cue: Point, gx: number, gy: number) {
    const dx = gx - cue.x, dy = gy - cue.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const ux = dx / len, uy = dy / len;
    for (const pk of engine.POCKETS) {
        const rx = pk.x - cue.x, ry = pk.y - cue.y;
        let t = rx * ux + ry * uy;
        t = Math.max(0, Math.min(len, t));
        const px = cue.x + ux * t, py = cue.y + uy * t;
        if (Math.hypot(pk.x - px, pk.y - py) < CUE_PATH_POCKET_AVOID) return false;
    }
    return true;
}

// simStraight(realIn, d, p, s) - run ONE shot through the faithful engine at the
// EXACT wire params the card will encode: 6dp-quantized d/p, x=0 spin,
// y=NEUTRAL_SPIN_Y follow, suit-lock s (the tri-state value stamped on the header).
// So the sim's cue rest + scratch verdict == what the tester's device re-derives.
function simStraight(realIn: RealBall[], d: number, p: number, s: number) {
    return realEngine.simulateShot(realIn, { d: q6(d), x: 0, y: NEUTRAL_SPIN_Y, p: q6(p), s: s | 0 }, { first: false });
}

// legalOutcome(real, legalSet, eightAllowed) - is the sim result a LEGAL, no-foul
// shot? Requires: cue NOT sunk, a legal ball contacted FIRST, no illegal ball dropped
// (cue / off-suit / early 8), all survivors on felt. Returns { potted, isPot } (a
// legal MISS has isPot=false) or null (the shot fouls - never emitted).
function legalOutcome(real: SimulationResult, legalSet: Set<number>, eightAllowed: boolean) {
    if (real.cueSunk) return null;                      // cue scratched => foul
    if (real.firstHit == null) return null;             // no legal first contact => foul
    if (real.firstHit === 8) { if (!eightAllowed) return null; }  // 8 first before group clear => foul
    else if (!legalSet.has(real.firstHit)) return null;           // wrong suit first => foul
    const potted = real.potted.map((x) => x.n);
    for (const pn of potted) {
        if (pn === 0) return null;                                // cue potted => scratch
        if (pn === 8) { if (!eightAllowed) return null; }         // early 8 => loss
        else if (!legalSet.has(pn)) return null;                  // off-suit ball down => foul
    }
    if (!postOnFelt(real)) return null;
    const objPots = potted.filter((n) => n !== 8);
    return { potted, isPot: objPots.length > 0 || potted.includes(8) };
}

// postOnFelt(real) - every surviving ball rests on legal felt (guard; the engine
// already keeps them there).
function postOnFelt(real: SimulationResult) {
    for (const b of real.postBalls) if (engine.isOffTable(b.x, b.y)) return false;
    return true;
}

// straightCandidates(preBalls, legal) - the STRAIGHT-FORWARD aims. For every legal
// target (nearest first = most reliable contact): (a) point the cue dead at the
// target center (drives it away, clean legal first contact - usually a legal miss,
// sometimes a pot); (b) a few NEAR-STRAIGHT pot aims into a clear pocket. No thin
// cuts, no banks - simple + legal.
function straightCandidates(preBalls: Ball[], legal: number[]): Candidate[] {
    const byN: Record<number, Ball> = {}; preBalls.forEach((b) => { byN[b.n] = b; });
    const cue = byN[0];
    const legalBalls = legal.map((n) => byN[n]).filter((t) => t && t.onTable !== false)
        .map((t) => ({ t, dist: Math.hypot(t.x - cue.x, t.y - cue.y) }))
        .sort((a, b) => a.dist - b.dist);
    const cands: Candidate[] = [];
    for (const { t } of legalBalls) {
        // (a) STRAIGHT at the target center.
        if (engine.pathClear(preBalls, cue, t.x, t.y, t.n) && cuePathClearOfPockets(cue, t.x, t.y)) {
            cands.push({ target: t.n, d: Math.atan2(t.y - cue.y, t.x - cue.x), kind: 'straight', pocket: null, cut: 0 });
        }
        // (b) NEAR-STRAIGHT easy pots into a clear pocket.
        for (const pk of engine.POCKETS) {
            const geom = engine.aimGhostBall(cue, t, pk);
            if (!geom) continue;
            if (geom.cutAngle > EASY_POT_CUT) continue;
            if (Math.hypot(pk.x - t.x, pk.y - t.y) > MAX_POT_TP) continue;
            if (!engine.pathClear(preBalls, cue, geom.ghostX, geom.ghostY, t.n)) continue;
            if (!engine.pathClear(preBalls, t, pk.x, pk.y, 0)) continue;
            if (!cuePathClearOfPockets(cue, geom.ghostX, geom.ghostY)) continue;
            cands.push({ target: t.n, d: geom.d, kind: 'pot', pocket: pk, cut: geom.cutAngle });
        }
    }
    return cands;
}

// resolveLegal(cand, realIn, legalSet, eightAllowed, s) - the FIRST firm power whose
// sim is a LEGAL shot with the cue resting clear of every pocket (scratch-flip guard).
// Enriches the candidate with the sim result. Returns null if no firm power is legal.
function resolveLegal(cand: Candidate, realIn: RealBall[], legalSet: Set<number>, eightAllowed: boolean, s: number): ResolvedShot | null {
    const d = q6(cand.d);   // sim + encode at the same 6dp wire value
    for (const p of SHOT_POWERS) {
        const real = simStraight(realIn, d, p, s);
        const out = legalOutcome(real, legalSet, eightAllowed);
        if (!out) continue;
        const cueMargin = nearestPocketDist(real.cue.x, real.cue.y);
        if (cueMargin < MIN_CUE_POCKET_MARGIN) continue;   // cue would rest knife-edge to a pocket
        return { ...cand, d, p, real, cueMargin, potted: out.potted, isPot: out.isPot };
    }
    return null;
}

// shotScore(s) - higher = safer/cleaner. Cue resting far from pockets dominates
// (fidelity), then actually striking the intended target, then a mild pot bonus.
function shotScore(s: ResolvedShot) {
    const cueSafe = Math.min(1, s.cueMargin / 200);
    const hitTarget = (s.real.firstHit === s.target) ? 1 : 0;
    const potBonus = s.isPot ? 1 : 0;
    return cueSafe * 0.5 + hitTarget * 0.3 + potBonus * 0.2;
}

// potConfidence(shot) - rank a confirmed pot. Straighter cut, cue resting far from
// pockets, a single-ball (low-chaos, reproducible) drop, and a closer target all
// raise confidence. This is a RANK, not a probability.
function potConfidence(shot: { cut: number; cueMargin: number; tp: number; claimObjects: number }) {
    const straight = 1 - Math.min(1, shot.cut / POT_MAX_CUT);   // 1 = dead straight
    const cueSafe = Math.min(1, shot.cueMargin / 200);          // 1 = cue far from pockets
    const closeness = 1 - Math.min(1, shot.tp / POT_MAX_TP);    // 1 = hanging in the jaws
    const single = shot.claimObjects <= 1 ? 1 : 0.5;            // single-ball pot = low chaos
    return straight * 0.40 + cueSafe * 0.25 + closeness * 0.20 + single * 0.15;
}

// Re-sim a made shot around its exact wire aim/power. A pot that only exists at one
// knife-edge parameter is not safe to chain: tiny recipient physics drift can turn
// it into a miss while the remaining encoded shots keep playing. That was the live
// "missed shot 2/3 but kept going" failure. Require the intended legal ball to drop
// in at least 4/5 probes before the shot may count as a continuation pot.
function potRobustness(realIn: RealBall[], shot: { d: number; p: number; target: number }, legalSet: Set<number>, eightAllowed: boolean, s: number) {
    const probes = [];
    for (const da of POT_ROBUSTNESS_AIM_OFFSETS) {
        for (const pm of POT_ROBUSTNESS_POWER_MULTIPLIERS) probes.push([da, pm]);
    }
    let ok = 0;
    for (const [da, pm] of probes) {
        const real = simStraight(realIn, shot.d + da, shot.p * pm, s);
        const out = legalOutcome(real, legalSet, eightAllowed);
        if (out && out.isPot && out.potted.includes(shot.target)) ok++;
    }
    return ok / probes.length;
}

// -----------------------------------------------------------------------------
// findPots(preBalls, legal, legalSet, eightAllowed, realIn, s) - every WASM-CONFIRMED
// pot. For each legal (target, pocket) the ghost-ball aim seeds a fine aim x power
// sweep; each is simulated through the faithful engine and kept only if it (a) SINKS
// the target, (b) is otherwise legal (no scratch / off-suit / early-8), and (c) leaves
// the cue >= MIN_CUE_POCKET_MARGIN from every pocket. The best (highest-confidence)
// aim per (target, pocket) is returned. The engine is the judge - the ghost-ball aim
// is only a starting point, so a pot only survives if the real physics confirms it.
// -----------------------------------------------------------------------------
function findPots(preBalls: Ball[], legal: number[], legalSet: Set<number>, eightAllowed: boolean, realIn: RealBall[], s: number): PotShot[] {
    const byN: Record<number, Ball> = {}; preBalls.forEach((b) => { byN[b.n] = b; });
    const cue = byN[0];
    const out = [];
    const robustMaxCut = eightAllowed ? WIN_POT_MAX_CUT : POT_CONTINUATION_MAX_CUT;
    const robustMaxTp = eightAllowed ? WIN_POT_MAX_TP : POT_CONTINUATION_MAX_TP;
    for (const tN of legal) {
        const t = byN[tN];
        if (!t || t.onTable === false) continue;
        for (const pk of engine.POCKETS) {
            const aim = engine.aimGhostBall(cue, t, pk);
            if (!aim) continue;
            if (aim.cutAngle > POT_MAX_CUT) continue;
            const tp = Math.hypot(pk.x - t.x, pk.y - t.y);
            if (tp > POT_MAX_TP) continue;
            if (aim.cutAngle > robustMaxCut || tp > robustMaxTp) continue;
            if (!engine.pathClear(preBalls, cue, aim.ghostX, aim.ghostY, t.n)) continue;
            if (!engine.pathClear(preBalls, t, pk.x, pk.y, 0)) continue;
            if (!cuePathClearOfPockets(cue, aim.ghostX, aim.ghostY)) continue;
            let best = null;
            for (const dd of (eightAllowed ? WIN_POT_AIM_SWEEP : POT_AIM_SWEEP)) {
                for (const p of POT_POWERS) {
                    const d = q6(aim.d + dd);   // sim + encode at the same 6dp wire value
                    const real = simStraight(realIn, d, p, s);
                    const outc = legalOutcome(real, legalSet, eightAllowed);
                    if (!outc || !outc.isPot) continue;
                    if (!outc.potted.includes(tN)) continue;   // must sink THIS target
                    const cueMargin = nearestPocketDist(real.cue.x, real.cue.y);
                    if (cueMargin < MIN_CUE_POCKET_MARGIN) continue;
                    const claimObjects = outc.potted.filter((n) => n !== 8).length;
                    const cand: PotShot = { target: tN, pocket: pk, d, p, real,
                        potted: outc.potted, isPot: true, cueMargin, cut: aim.cutAngle, tp, claimObjects,
                        confidence: 0, robustness: 0 };
                    cand.confidence = potConfidence(cand);
                    cand.robustness = potRobustness(realIn, cand, legalSet, eightAllowed, s);
                    if (!best || cand.robustness > best.robustness
                        || (cand.robustness === best.robustness && cand.confidence > best.confidence)) best = cand;
                }
            }
            if (best) {
                if (best.robustness >= (eightAllowed ? WIN_POT_MIN_ROBUSTNESS : POT_MIN_ROBUSTNESS)) out.push(best);
            }
        }
    }
    return out;
}

// findSafeShots(preBalls, legal, legalSet, eightAllowed, realIn, s) - the SAFE
// fallback pool: firm straight LEGAL strikes at a legal target (aimed sensibly, never
// random), each verified legal + cue-safe through the faithful engine, ranked cue-
// safest first. Used when no makeable pot exists, and as the honest-miss target when
// fair-play declines a pot.
function findSafeShots(preBalls: Ball[], legal: number[], legalSet: Set<number>, eightAllowed: boolean, realIn: RealBall[], s: number): ResolvedShot[] {
    const resolved: ResolvedShot[] = [];
    for (const cand of straightCandidates(preBalls, legal)) {
        const r = resolveLegal(cand, realIn, legalSet, eightAllowed, s);
        if (r) resolved.push(r);
    }
    resolved.forEach((x) => { x.score = shotScore(x); });
    resolved.sort((a, b) => b.score! - a.score!);
    return resolved;
}

// -----------------------------------------------------------------------------
// findNearMisses(preBalls, legal, legalSet, eightAllowed, realIn, s) - engine-
// verified PLAUSIBLE misses (eased-miss quality fix). For each legal (target,
// pocket) pot LINE (geometric prefilter only - the line need not be a confirmed
// makeable pot), the ghost-ball aim is perturbed just OUTSIDE the pot window
// (smallest offset first) at pot-pace power and simulated; the first offset that is
// LEGAL, does NOT pot, leaves the cue >= MIN_CUE_POCKET_MARGIN from every pocket,
// and ends the target within NEAR_MISS_RATTLE_PX of the intended pocket is kept for
// that line. The result is a jaw rattle / lip-out on a real pot line - it reads as a
// genuine attempt, never a random smash. Ranked by how close the target finishes to
// the pocket. Used when fair-play DECLINES a pot, and when NO pot verifies (the old
// path emitted a dead-center full-ball strike with zero pocket intent - the
// "lobotomized turn" the tester saw).
// -----------------------------------------------------------------------------
function findNearMisses(preBalls: Ball[], legal: number[], legalSet: Set<number>, eightAllowed: boolean, realIn: RealBall[], s: number): NearMissShot[] {
    const byN: Record<number, Ball> = {}; preBalls.forEach((b) => { byN[b.n] = b; });
    const cue = byN[0];
    const out: NearMissShot[] = [];
    for (const tN of legal) {
        const t = byN[tN];
        if (!t || t.onTable === false) continue;
        for (const pk of engine.POCKETS) {
            const aim = engine.aimGhostBall(cue, t, pk);
            if (!aim) continue;
            if (aim.cutAngle > POT_MAX_CUT) continue;
            const tp = Math.hypot(pk.x - t.x, pk.y - t.y);
            if (tp > NEAR_MISS_MAX_TP) continue;
            if (!engine.pathClear(preBalls, cue, aim.ghostX, aim.ghostY, t.n)) continue;
            if (!cuePathClearOfPockets(cue, aim.ghostX, aim.ghostY)) continue;
            let found = null;      // first true rattle (<= NEAR_MISS_RATTLE_PX) on this line
            let loose = null;      // best pocket-bound fallback (<= NEAR_MISS_LOOSE_PX)
            for (const dd of NEAR_MISS_OFFSETS) {
                for (const p of NEAR_MISS_POWERS) {
                    const d = q6(aim.d + dd);
                    const real = simStraight(realIn, d, p, s);
                    const outc = legalOutcome(real, legalSet, eightAllowed);
                    if (!outc || outc.isPot) continue;           // must be a LEGAL non-pot (honest miss)
                    const cueMargin = nearestPocketDist(real.cue.x, real.cue.y);
                    if (cueMargin < MIN_CUE_POCKET_MARGIN) continue;
                    const rest = real.postBalls.find((b) => b.n === tN);
                    if (!rest) continue;
                    const endDist = Math.hypot(rest.x - pk.x, rest.y - pk.y);
                    if (endDist > NEAR_MISS_LOOSE_PX) continue;  // not attempt-shaped at all
                    const cand = { target: tN, pocket: pk, d, p, real, potted: outc.potted, isPot: false,
                        cueMargin, cut: aim.cutAngle, tp, endDist };
                    if (endDist <= NEAR_MISS_RATTLE_PX) { found = cand; break; }
                    if (!loose || endDist < loose.endDist) loose = cand;
                }
                if (found) break;   // smallest verifying offset = the closest rattle on this line
            }
            if (found || loose) out.push((found || loose)!);
        }
    }
    out.sort((a, b) => a.endDist - b.endDist);
    return out;
}

// -----------------------------------------------------------------------------
// chooseBallInHandCue(preBalls, legal, legalSet, eightAllowed, s) - BALL-IN-HAND
// placement. Bot just got ball-in-hand (the tester fouled / scratched). Set up the easiest
// STRAIGHT pot on a legal target: for each legal (target, pocket) with a clear
// target->pocket lane, place the cue behind the ghost ball ON that line at a set-back
// distance so cue->target->pocket is collinear (cut ~= 0), then VERIFY through the
// faithful engine that the straight shot legally pots the target with the cue left
// clear of pockets. Returns the closest verified placement { x, y }, or null.
// -----------------------------------------------------------------------------
function chooseBallInHandCue(preBalls: Ball[], legal: number[], legalSet: Set<number>, eightAllowed: boolean, s: number) {
    const byN: Record<number, Ball> = {}; preBalls.forEach((b) => { byN[b.n] = b; });
    const others = preBalls.filter((b) => b.n !== 0 && b.onTable !== false);
    let best = null;
    for (const tN of legal) {
        const t = byN[tN]; if (!t || t.onTable === false) continue;
        for (const pk of engine.POCKETS) {
            const ux = pk.x - t.x, uy = pk.y - t.y; const L = Math.hypot(ux, uy);
            if (L < 1e-6) continue;
            const nx = ux / L, ny = uy / L;
            if (!engine.pathClear(preBalls, t, pk.x, pk.y, 0)) continue;   // target -> pocket lane clear
            for (const pull of IN_HAND_PULLBACKS) {
                const cx = t.x - nx * (engine.R2 + pull), cy = t.y - ny * (engine.R2 + pull);
                if (!engine.simInsideFelt(cx, cy)) continue;
                if (nearestPocketDist(cx, cy) < MIN_CUE_POCKET_MARGIN + 10) continue;
                let overlap = false;
                for (const o of others) { if (Math.hypot(o.x - cx, o.y - cy) < engine.R2 + 3) { overlap = true; break; } }
                if (overlap) continue;
                const fakeCue = { n: 0, x: cx, y: cy, onTable: true };
                if (!engine.pathClear(preBalls, fakeCue, t.x, t.y, tN)) continue;   // cue -> target lane clear
                const trial = preBalls.map((b) => (b.n === 0 ? { ...b, x: cx, y: cy, onTable: true } : b));
                if (!byN[0]) trial.push(fakeCue);
                const realIn = toRealInput(trial);
                const d = q6(Math.atan2(ny, nx));
                let ok = false;
                for (const p of IN_HAND_POWERS) {
                    const real = simStraight(realIn, d, p, s);
                    const out = legalOutcome(real, legalSet, eightAllowed);
                    if (out && out.isPot && out.potted.includes(tN) &&
                        nearestPocketDist(real.cue.x, real.cue.y) >= MIN_CUE_POCKET_MARGIN) { ok = true; break; }
                }
                if (!ok) continue;
                const cand = { x: cx, y: cy, tp: L, target: tN };
                if (!best || cand.tp < best.tp) best = cand;
                break;   // first working set-back on this line
            }
        }
    }
    return best;
}

// defaultCueSpot(preBalls) - a safe legal ball-in-hand spot when no straight pot could
// be staged (or the cue must be injected because the tester scratched it off the table).
// First free spot from a small central candidate list; table center as last resort.
function defaultCueSpot(preBalls: Ball[]) {
    const others = preBalls.filter((b) => b.n !== 0 && b.onTable !== false);
    for (const [cx, cy] of DEFAULT_CUE_SPOTS) {
        if (!engine.simInsideFelt(cx, cy)) continue;
        if (nearestPocketDist(cx, cy) < MIN_CUE_POCKET_MARGIN) continue;
        let overlap = false;
        for (const o of others) { if (Math.hypot(o.x - cx, o.y - cy) < engine.R2 + 3) { overlap = true; break; } }
        if (!overlap) return { x: cx, y: cy };
    }
    return { x: 392, y: 220 };
}

// buildForcedFoulShot(preBalls, legal, legalSet, eightAllowed, s) - NO-LEGAL-SHOT
// fallback. Bot is snookered (planRun found no legal shot). Instead of stalling the
// game, play a real, on-felt, animatable contact shot at the nearest reachable ball at
// gentle pace. Whether it is a FOUL is decided by the faithful engine (legalOutcome
// null => foul); a real foul stamps `&o:1` so the tester gets ball-in-hand, a clean legal
// miss does not. Never scratches (keeps a clean cue in the POST). Returns
// { segment:{d,x,y,p,s}, post, foul, firstHit } or null (truly nothing to hit).
// -----------------------------------------------------------------------------
function buildForcedFoulShot(preBalls: Ball[], _legal: number[], legalSet: Set<number>, eightAllowed: boolean, s: number) {
    const byN: Record<number, Ball> = {}; preBalls.forEach((b) => { byN[b.n] = b; });
    const cue = byN[0];
    if (!cue || cue.onTable === false) return null;
    const targets = preBalls.filter((b) => b.n !== 0 && b.onTable !== false)
        .map((t) => ({ t, dist: Math.hypot(t.x - cue.x, t.y - cue.y) }))
        .sort((a, b) => a.dist - b.dist);
    const realIn = toRealInput(preBalls);
    for (const { t } of targets) {
        if (!engine.pathClear(preBalls, cue, t.x, t.y, t.n)) continue;   // a real, animatable contact
        const d = q6(Math.atan2(t.y - cue.y, t.x - cue.x));
        for (const p of FORCED_POWERS) {
            const real = simStraight(realIn, d, p, s);
            if (real.cueSunk || real.firstHit == null) continue;         // keep a clean cue in the POST
            const { post, oob } = buildPostFromReal(preBalls, real);
            if (oob.length) continue;
            if (validateCardReal(post)) continue;
            const out = legalOutcome(real, legalSet, eightAllowed);
            return { segment: { d, x: 0.0, y: NEUTRAL_SPIN_Y, p, s }, post, foul: out == null, firstHit: real.firstHit };
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// selectStraightShot(preBalls, legal, opts) - pick Bot's shot, POT-FIRST. Returns
// { kind:'pot'|'nearmiss'|'straight', shot, candidates } or { skip:reason }.
//   * Search every WASM-confirmed pot (findPots) + the safe legal fallback pool.
//   * If a pot is makeable, take the highest-confidence one - INCLUDING the winning 8
//     when only the 8 is legal (findPots offers 8-pots only once the group is clear).
//   * FAIR-PLAY: as skill drops Bot increasingly declines the pot - RAMPED over the
//     run via opts.shotIndex so the first shot of a turn is rarely a give-up - and
//     the declined shot is an engine-verified NEAR-MISS on a real pot line (jaw
//     rattle), never an aimless strike. It also biases toward a harder
//     (lower-confidence) pot when it does shoot.
//   * No makeable pot => a near-miss on the best geometric pot line, else the safest
//     aimed legal fallback shot (never random).
//   * Nothing legal at all => skip (never emit a foul / gentle no-contact tap).
// opts: { factor, lock (tri-state wire s), shotIndex (0-based within the run) }.
// (Legacy opts.inStripes 0/1 still accepted from the dry-run harness.)
// -----------------------------------------------------------------------------
function selectStraightShot(preBalls: Ball[], legal: number[], opts?: SelectOptions): Selection {
    opts = opts || {};
    const factor = opts.factor != null ? opts.factor : 1;
    const sLock = opts.lock != null ? (opts.lock | 0) : (opts.inStripes ? 1 : 0);
    const shotIndex = opts.shotIndex != null ? opts.shotIndex : 0;
    const byN: Record<number, Ball> = {}; preBalls.forEach((b) => { byN[b.n] = b; });
    const cue = byN[0];
    if (!cue || cue.onTable === false) {
        return { skip: 'cue not on table (opponent scratched - Bot ball-in-hand not yet supported)' };
    }
    const legalSet = new Set(legal);
    const eightAllowed = legal.length === 1 && legal[0] === 8;
    const realIn = toRealInput(preBalls);

    const pots = findPots(preBalls, legal, legalSet, eightAllowed, realIn, sLock);
    const safes = findSafeShots(preBalls, legal, legalSet, eightAllowed, realIn, sLock);
    if (pots.length === 0 && safes.length === 0) {
        return { skip: 'no legal shot on this table (every candidate fouled in sim)' };
    }
    const total = pots.length + safes.length;

    if (pots.length > 0) {
        // On the legal 8, winning reliability outranks difficulty theatre. Normal
        // object-ball play keeps the confidence ordering and human-skill bias.
        pots.sort(eightAllowed
            ? (a, b) => b.robustness - a.robustness || b.confidence - a.confidence
            : (a, b) => b.confidence - a.confidence);
        const skill = fair.factorToSkill(factor);
        const rng = fair.mulberry32(engine.tableSeed(preBalls));
        // FAIR-PLAY decline, RAMPED over the run: never deliberately miss the first
        // makeable shot. Easing begins on shot 2 and reaches full weight on shot 3,
        // shortening a friendly run without producing dead turn after dead turn.
        const declineProgress = (shotIndex === 0 || eightAllowed) ? 0
            : Math.min(1, shotIndex / Math.max(1, DECLINE_RAMP_SHOTS - 1));
        const declineCap = MAX_DECLINE * declineProgress;
        if (fair.chance(skill, declineCap, rng)) {
            // Declined the pot - emit a PLAUSIBLE near-miss on a real pot line (the
            // target rattles the pocket), falling back to a straight legal miss. If
            // no honest miss verifies at all, fall through and shoot the pot.
            const nears = findNearMisses(preBalls, legal, legalSet, eightAllowed, realIn, sLock);
            if (nears.length > 0) return { kind: 'nearmiss', shot: nears[0], candidates: total };
            const miss = safes.find((x) => !x.isPot);
            if (miss) return { kind: 'straight', shot: miss, candidates: total };
        }
        // FAIR-PLAY pot choice: surest pot at high skill, bias toward a harder pot
        // (lower confidence) as skill drops.
        const span = pots.length - 1;
        const idx = eightAllowed ? 0 : (span > 0 ? Math.round(fair.wildness(skill) * span) : 0);
        const chosen = pots[Math.min(span, Math.max(0, idx))];
        return { kind: 'pot', shot: chosen, candidates: total };
    }

    // No WASM-confirmed pot. Take a fallback pot if the safe pool resolved one; else a
    // near-miss on the best geometric pot line (a genuine-looking attempt - this used
    // to be the aimless full-ball-smash path); else the safest straight legal strike.
    const potSafe = safes.find((x) => x.isPot &&
        potRobustness(realIn, x, legalSet, eightAllowed, sLock) >= POT_MIN_ROBUSTNESS);
    if (potSafe) return { kind: 'pot', shot: potSafe, candidates: total };
    const nears = findNearMisses(preBalls, legal, legalSet, eightAllowed, realIn, sLock);
    if (nears.length > 0) return { kind: 'nearmiss', shot: nears[0], candidates: total };
    return { kind: 'straight', shot: safes[0], candidates: total };
}

// -----------------------------------------------------------------------------
// inferBotSuit(board) - CORRUPT-TAIL FALLBACK ONLY. Bot's group is normally
// derived exactly from the tri-state lock + its player slot (see decideMove); this
// ball-count guess ("the group with more balls left is probably the shooter's")
// flip-flops as counts change mid-game and must never drive a healthy card - it is
// used only when the inbound tail is missing or outside {0,1,2}.
// -----------------------------------------------------------------------------
function inferBotSuit(board: Ball[]): Suit {
    const onTable = new Set(board.filter((b) => b.onTable !== false).map((b) => b.n));
    const solidsLeft = SOLIDS.filter((n) => onTable.has(n)).length;
    const stripesLeft = STRIPES.filter((n) => onTable.has(n)).length;
    return stripesLeft > solidsLeft ? 'stripes' : 'solids';
}

// -----------------------------------------------------------------------------
// planRun(board0, opts) - CHAIN a whole turn (BUG-2 fix). In 8-ball a legal pot keeps
// the turn, so Bot keeps shooting while it keeps legally potting: after each WASM-
// confirmed pot it re-plans on the resulting table and shoots again. The run ENDS on a
// legal MISS (turn passes, no ball-in-hand) or a legal 8-pot WIN - exactly like a hand-
// played run, whose card is a K-segment replay.
//
//   opts = { factor, lock (tri-state 0|1|2), botSuit ('solids'|'stripes'|null),
//            player (Bot's slot 1|2), opponent (the other slot) }
//   (Legacy: inStripes 0|1 is still accepted from the dry-run harness and mapped
//    onto the tri-state via botSuit + player.)
//
// Returns one of:
//   { skip: reason }                                    - no legal FIRST shot (never emit)
//   { segments:[{d,x,y,p,s,...}], finalPost:[balls],    - a playable run
//     outStripes, botSuit, win, claim:[n], firstContact, cueMargin, kinds:[...] }
//
// TRI-STATE LOCK (suit fix 2026-07-09e): `lock` is the stripes-OWNERSHIP value on
// the wire - 0 = open, 1 = player 1 owns stripes, 2 = player 2 owns stripes. Each
// segment stamps s = the lock ENTERING that shot; `outStripes` = the final lock. A
// LOCKED table's value is echoed VERBATIM on every segment + the tail (ownership can
// never change mid-game). When Bot pots first on an OPEN table the lock becomes the
// stripes-owner's PLAYER NUMBER: Bot's own number if it potted a stripe, the
// opponent's if it potted a solid. The board threads shot-to-shot through the
// faithful engine AT WIRE PRECISION (6dp per hop), so every intermediate state is
// exactly what the recipient re-animates from the rounded headers.
// -----------------------------------------------------------------------------
function planRun(board0: Ball[], opts?: RunOptions): PlannedRun | Skipped {
    opts = opts || {};
    const factor = opts.factor != null ? opts.factor : 1;
    const player = opts.player === 2 ? 2 : 1;
    const opponent = player === 1 ? 2 : 1;
    let botSuit = opts.botSuit || null;
    let lock;
    if (opts.lock != null) lock = opts.lock | 0;
    else if (opts.inStripes) lock = botSuit === 'solids' ? opponent : player;   // legacy harness shim
    else lock = 0;
    if (lock !== 0 && !botSuit) botSuit = lock === player ? 'stripes' : 'solids';
    let board = board0.map((b) => ({ ...b }));
    const segments: RunSegment[] = [];
    const claim: number[] = [];
    let win = false;

    while (segments.length < RUN_MAX_SHOTS) {
        const firstShot = segments.length === 0;

        const legal = legalTargetsFor(board, { stripes: lock !== 0 ? 1 : 0, botSuit });
        if (legal.length === 0) break;   // nothing legal (post-win / fully cleared)

        const selection = selectStraightShot(board, legal, { factor, lock, shotIndex: segments.length });
        if (selection.skip !== undefined) {
            if (firstShot) return { skip: selection.skip };
            break;                       // rare: no legal continuation after a pot - end the run here
        }
        const chosen = selection.shot;
        const real = chosen.real;

        const shotClaim = (chosen.potted || []).filter((n) => n !== 0);
        const claimObjects = shotClaim.filter((n) => n !== 8);
        const claim8 = shotClaim.includes(8);

        // WIN check: the 8 drops only after Bot's whole group is cleared.
        const botGroup = botSuit === 'stripes' ? STRIPES : botSuit === 'solids' ? SOLIDS : null;
        const onTableBefore = new Set(board.filter((b) => b.onTable !== false).map((b) => b.n));
        const groupCleared = botGroup ? botGroup.every((n) => !onTableBefore.has(n)) : true;
        const isLegalWin = claim8 && groupCleared;
        if (claim8 && !isLegalWin) {
            // Engine sank the 8 with the group not cleared - an illegal loss. Never emit
            // it: drop the whole shot and end the run before it (a miss terminator would
            // already have ended the turn, so just stop here).
            if (firstShot) {
                return { skip: 'engine sank the 8 with group not cleared - skipping to avoid an illegal-8 desync' };
            }
            break;
        }

        // POST = the engine's TRUE end-state of THIS shot (self-consistent, on-felt).
        const { post, oob } = buildPostFromReal(board, real);
        if (oob.length) {
            if (firstShot) {
                return { skip: 'POST had off-felt balls (' + JSON.stringify(oob) + ') - skipping rather than emit an off-felt ball' };
            }
            break;
        }
        const bad = validateCardReal(post);
        if (bad) {
            if (firstShot) {
                return { skip: 'card failed emit-side validation (' + bad + ') - skipping rather than emit an unplayable card' };
            }
            break;
        }

        // Commit this shot as a segment (s = the lock ENTERING this shot). endDist is
        // diagnostic-only: how close a near-miss left its target to the intended pocket.
        segments.push({
            d: chosen.d, x: 0.0, y: NEUTRAL_SPIN_Y, p: chosen.p, s: lock,
            kind: selection.kind, target: chosen.target, pocket: chosen.pocket,
            cut: chosen.cut, cueMargin: chosen.cueMargin, firstContact: real.firstHit,
            isPot: chosen.isPot, claim: shotClaim, endDist: chosen.endDist,
        });
        claim.push(...claimObjects);
        // Thread the next shot from the 6dp-QUANTIZED table: the recipient re-derives
        // every intermediate board from the rounded wire headers, so planning at wire
        // precision keeps the whole chain reproducing on-device (no knife-edge
        // "potted ball snaps back out" residuals between segments).
        board = post.map((b) => ({ ...b, x: q6(b.x), y: q6(b.y) }));

        // An OPEN-table pot locks suits: the lock value becomes the stripes-owner's
        // PLAYER NUMBER (Bot's own if it potted a stripe, the opponent's for a solid).
        if (lock === 0 && claimObjects.length > 0) {
            const stripesPotted = claimObjects.filter((n) => STRIPES.includes(n)).length;
            const solidsPotted = claimObjects.length - stripesPotted;
            botSuit = stripesPotted > solidsPotted ? 'stripes' : 'solids';
            lock = botSuit === 'stripes' ? player : opponent;
        }

        if (isLegalWin) { win = true; break; }   // 8 down legally - game over
        if (!chosen.isPot) break;                 // legal MISS - turn passes to the tester
        // else: potted an object ball - keep shooting (loop continues)
    }

    if (segments.length === 0) return { skip: 'no legal shot on this table (every candidate fouled in sim)' };
    const last = segments[segments.length - 1];
    return {
        segments, finalPost: board, outStripes: lock, botSuit, win, claim,
        firstContact: segments[0].firstContact, cueMargin: last.cueMargin,
        kinds: segments.map((s) => s.kind),
    };
}

// -----------------------------------------------------------------------------
// buildPostFromReal(preBalls, real) - POST = the engine's TRUE end-state. Potted
// object balls dropped; cue at its engine rest position (present - accepted shots
// never scratch); cosmetics carried through; original entry order preserved.
// Returns { post:[balls], scratched:bool, oob:[{n,x,y}] }.
// -----------------------------------------------------------------------------
function buildPostFromReal(preBalls: Ball[], real: SimulationResult) {
    const realByN: Record<number, SimulationResult["postBalls"][number]> = {}; real.postBalls.forEach((b) => { realByN[b.n] = b; });
    const post = [];
    const oob: ({ n: number; reason: string } | { n: number; x: number; y: number })[] = [];
    for (const pb of preBalls) {
        if (pb.onTable === false) continue;
        if (pb.n === 0) {
            if (!real.cue || real.cue.potted) { oob.push({ n: 0, reason: 'cue potted' }); continue; }
            const cb = { ...pb, x: real.cue.x, y: real.cue.y, onTable: true };
            engine.settleToFelt(cb);
            if (!engine.simInsideFelt(cb.x, cb.y)) oob.push({ n: 0, x: cb.x, y: cb.y });
            post.push(cb);
            continue;
        }
        const rr = realByN[pb.n];
        if (!rr) continue;                          // potted this shot - dropped from POST
        const b = { ...pb, x: rr.x, y: rr.y, onTable: true };
        engine.settleToFelt(b);
        if (!engine.simInsideFelt(b.x, b.y)) oob.push({ n: b.n, x: b.x, y: b.y });
        post.push(b);
    }
    return { post, scratched: !!real.cueSunk, oob };
}

// -----------------------------------------------------------------------------
// validateCardReal(post) - the emit-side gate. POST self-consistency is STRUCTURAL
// (POST is built from the engine's own result of the encoded d/p), so this checks
// the invariants that keep the card PLAYABLE: cue present + on felt, every ball on
// felt, and the cue rests clear of every pocket (the scratch-flip safety margin).
// Returns null if clean, or a reason string.
// -----------------------------------------------------------------------------
function validateCardReal(post: Ball[]) {
    const cue = post.find((b) => b.n === 0);
    if (!cue) return 'cue ball (0) absent from POST - the tester could not shoot';
    if (!engine.simInsideFelt(cue.x, cue.y)) {
        return 'cue rests off legal felt (' + cue.x.toFixed(1) + ',' + cue.y.toFixed(1) + ')';
    }
    for (const b of post) {
        if (!engine.simInsideFelt(b.x, b.y)) {
            return 'ball ' + b.n + ' rests off legal felt (' + b.x.toFixed(1) + ',' + b.y.toFixed(1) + ')';
        }
    }
    const cueMargin = nearestPocketDist(cue.x, cue.y);
    if (cueMargin < MIN_CUE_POCKET_MARGIN) {
        return 'cue rests ' + cueMargin.toFixed(0) + 'px from a pocket (< ' + MIN_CUE_POCKET_MARGIN + ' - scratch-flip risk)';
    }
    return null;
}

// -----------------------------------------------------------------------------
// decideMove(state, ctx, solve) - see interface. Returns:
//   { action:'skip', reason, ... }    - malformed / observe-gated / no safe shot
//   { action:'play', newState, ... }  - a fully-built reply (only sent if armed)
//   { action:'invite', newState, ... }- a fresh Bot-sent invite (YOU-BREAK)
//   { action:'result', ... } / { action:'ignore' }
// -----------------------------------------------------------------------------
function decideMove(state: PoolState, ctx: (PlayerIdentity & { rbState?: unknown }) | null | undefined, solveCtx: SolveContext | null | undefined) {
    const factor = rb.handicapFactor(ctx && ctx.rbState);
    const botUuid = ctx && ctx.botUuid;
    const botAvatar = ctx && ctx.botAvatar;
    const base = { mode: 'pool', botScore: 0, botWords: 0, fullScore: 0, fullWords: 0, targetN: null };

    if (!solveCtx || solveCtx.kind === 'finished') {
        return { ...base, action: 'ignore' };
    }

    // --- BREAK: fresh invite. Bot BREAKS (makes the first move) --------------
    // ROBUST no-teleport break (BUG-1 fix, 2026-07-09d): Bot REPLAYS A REAL the tester
    // iPHONE BREAK verbatim (see the REAL CAPTURED BREAKS section). GamePigeon replays
    // are deterministic on-device, so the tester's phone re-animates the captured header and
    // reproduces the captured scatter exactly -> animation == snapped POST => zero
    // teleport, and the WASM never touches the break scatter. A captured break pots
    // nothing (clean turn-pass, open table, no run to chain) and rests the cue safely on
    // felt (no phantom ball-in-hand). If the capture library is empty we fall back to the
    // WASM-simulated break, then to a YOU-BREAK re-invite.
    if (solveCtx.kind === 'break') {
        const { player, opponent } = botSlot(state, botUuid);

        // PRIMARY: verbatim replay of a real captured the tester iPhone break.
        const realBreak = pickRealBreak(state.id);
        if (realBreak) {
            const gs = poolGameplayState(state, { player, botUuid, botAvatar });
            const newState: PoolState = { ...gs, replay: realBreak.replay };
            const hdr = parseReplay(realBreak.replay);
            const cuePost = ((hdr && hdr.post) || []).find((b) => b.n === 0);
            const cueMargin = cuePost ? nearestPocketDist(cuePost.x, cuePost.y) : 0;
            return {
                ...base,
                action: ENABLE_SEND ? 'play' : 'skip',
                reason: ENABLE_SEND ? undefined
                    : 'real-break replay (' + realBreak.source + ', rowid ' + realBreak.rowid +
                      '; verbatim, pots nothing, cueMargin=' + cueMargin.toFixed(0) +
                      'px) but GP_POOL_SEND unset (observe-only)',
                newState, player, opponent, aim: hdr ? hdr.d : null, factor,
                planned: {
                    kind: 'break', real: true, rowid: realBreak.rowid,
                    power: hdr ? hdr.p : null, claim: [],
                    cueRest: cuePost ? { x: Math.round(cuePost.x), y: Math.round(cuePost.y) } : null,
                    cueMargin, stripes: 0,
                },
            };
        }

        // FALLBACK: WASM-simulated break (only if the capture library is empty).
        if (!engineReady()) {
            return { ...base, action: 'skip', reason: 'real-physics engine still warming up (break)' };
        }
        const built = buildBreakThroughEngine(solveCtx.seed);
        if (!built) {
            const invite = buildInvite(state, { botUuid, botAvatar });
            return {
                ...base, action: ENABLE_SEND ? 'invite' : 'skip',
                reason: ENABLE_SEND ? undefined
                    : 'no safe WASM break found; would re-invite so the tester breaks (observe-only)',
                newState: invite, player, opponent, factor,
                planned: { kind: 'invite', note: 'fallback re-invite (no safe WASM break)' },
            };
        }
        const newReplay = buildReplay({
            d: BREAK_AIM, x: 0.0, y: NEUTRAL_SPIN_Y, p: built.p, s: 0,
            pre: built.preBalls, post: built.post, stripes: 0,
        });
        const gs = poolGameplayState(state, { player, botUuid, botAvatar });
        const newState: PoolState = { ...gs, replay: newReplay };
        const cueMargin = nearestPocketDist(built.real.cue.x, built.real.cue.y);
        return {
            ...base,
            action: ENABLE_SEND ? 'play' : 'skip',
            reason: ENABLE_SEND ? undefined
                : 'WASM-break fallback (Bot breaks; cueMargin=' + cueMargin.toFixed(0) + 'px, p=' + built.p +
                  ', potted=' + JSON.stringify(built.potted) + ') but GP_POOL_SEND unset (observe-only)',
            newState, player, opponent, aim: BREAK_AIM, factor,
            planned: {
                kind: 'break', power: built.p, claim: built.potted,
                cueRest: { x: Math.round(Number(built.real.cue.x)), y: Math.round(Number(built.real.cue.y)) },
                cueMargin, firstContact: built.real.firstHit, stripes: 0,
            },
        };
    }

    // --- SHOT: gameplay card, plan Bot's whole turn as a RUN ----------------
    if (!engineReady()) {
        return { ...base, action: 'skip', reason: 'real-physics engine still warming up (WASM not loaded)' };
    }

    const { parsed } = solveCtx;
    const { player, opponent } = botSlot(state, botUuid);
    const oppBallInHand = parsed.ballInHand === 1;   // the tester fouled -> Bot has ball-in-hand

    const preReason = safetyCheck(parsed.post); // opponent's post = our pre state
    // A missing cue is normally fatal, but when the tester FOULED (&o:1) the cue was
    // scratched off the table and Bot has ball-in-hand - it will PLACE a fresh cue
    // (below) rather than skip the whole turn.
    if (preReason && !(oppBallInHand && /cue ball/.test(preReason))) {
        return { ...base, action: 'skip', reason: 'incoming card malformed: ' + preReason };
    }

    const preBalls = entriesToBalls(parsed.post);

    // TRI-STATE SUIT LOCK (suit fix 2026-07-09e). &stripes: / per-segment s is a
    // suit-OWNERSHIP value, NOT a boolean: 0 = table open, 1 = PLAYER 1 owns stripes,
    // 2 = PLAYER 2 owns stripes (the other player owns solids). Decoded empirically
    // from the tester's own cards: when he (player 2) potted stripe 12 first, his device
    // stamped s:2 / &stripes:2. The recipient trusts the inbound tail VERBATIM and
    // re-derives both players' groups from it, so Bot's group is computed from the
    // lock + its own slot. (The old code collapsed the lock to 0/1 and re-stamped
    // every locked table as 1 = "player 1 [Bot] owns stripes", silently stealing
    // The tester's group; its ball-count guess also flip-flopped Bot's own target group
    // mid-game.) inferBotSuit survives ONLY as the corrupt-tail fallback.
    const rawLock = parsed.stripes;
    let lock: number, botSuit: Suit | null;
    if (rawLock === 1 || rawLock === 2) {
        lock = rawLock;
        botSuit = lock === player ? 'stripes' : 'solids';
    } else if (rawLock === 0) {
        lock = 0;
        botSuit = null;
    } else {
        // Corrupt / missing tail - infer from the table and encode a lock consistent
        // with the inference (the stripes-owner's player number).
        botSuit = inferBotSuit(preBalls);
        lock = botSuit === 'stripes' ? player : opponent;
    }

    // BALL-IN-HAND (2026-07-10). If the tester fouled (&o:1) or scratched the cue off the
    // table, Bot may place the cue anywhere legal. It stages the easiest straight pot
    // on its own group (verified in sim), else a safe default spot - the visible "next
    // player moves the ball" a foul earns. Bot only repositions on a REAL foul signal;
    // a normal turn keeps the cue exactly where the tester left it (no phantom teleport).
    const cueEntry = preBalls.find((b) => b.n === 0);
    const cueMissing = !cueEntry || cueEntry.onTable === false;
    if (oppBallInHand || cueMissing) {
        const legalBIH = legalTargetsFor(preBalls, { stripes: lock !== 0 ? 1 : 0, botSuit });
        const eightBIH = legalBIH.length === 1 && legalBIH[0] === 8;
        const place = chooseBallInHandCue(preBalls, legalBIH, new Set(legalBIH), eightBIH, lock)
            || (cueMissing ? defaultCueSpot(preBalls) : null);
        if (place) {
            if (cueEntry) { cueEntry.x = place.x; cueEntry.y = place.y; cueEntry.onTable = true; }
            else preBalls.push({ n: 0, x: place.x, y: place.y, f3: 0, f4: 1, r1: 0, r2: 0, r3: 0, onTable: true });
        }
    }

    // Plan Bot's whole TURN as a RUN (BUG-2 fix): keep shooting while it keeps legally
    // potting, ending on a legal MISS (turn passes) or a legal 8-pot WIN. planRun threads
    // the board shot-to-shot through the faithful engine and returns the K segments.
    const run = planRun(preBalls, { factor, lock, botSuit, player, opponent });
    if (run.skip !== undefined) {
        // Snookered - no legal shot. Rather than STALL the game (the old skip left the tester
        // waiting forever), Bot plays a real forced contact shot. If the engine calls it
        // a genuine foul it stamps &o:1 so the tester gets ball-in-hand; a clean legal miss
        // does not. Only if there is truly nothing to hit does Bot skip.
        const legalNow = legalTargetsFor(preBalls, { stripes: lock !== 0 ? 1 : 0, botSuit });
        const eightNow = legalNow.length === 1 && legalNow[0] === 8;
        const forced = buildForcedFoulShot(preBalls, legalNow, new Set(legalNow), eightNow, lock);
        if (forced) {
            const forcedReplay = buildRunReplay({
                segments: [forced.segment], pre: preBalls, post: forced.post,
                stripes: lock, ballInHand: forced.foul ? 1 : 0,
            });
            const gsF = poolGameplayState(state, { player, botUuid, botAvatar });
            const newStateF = { ...gsF, replay: forcedReplay };
            return {
                ...base,
                action: ENABLE_SEND ? 'play' : 'skip',
                reason: ENABLE_SEND ? undefined
                    : 'forced ' + (forced.foul ? 'FOUL (grants the tester ball-in-hand via &o:1)' : 'legal safety') +
                      ' - no run available (' + run.skip + ') but GP_POOL_SEND unset (observe-only)',
                newState: newStateF, player, opponent, aim: forced.segment.d, factor,
                planned: {
                    kind: 'forced', foul: forced.foul, firstContact: forced.firstHit,
                    oppBallInHand, botSuit, stripes: lock, grantedBallInHand: forced.foul,
                },
            };
        }
        return { ...base, action: 'skip', reason: run.skip };
    }

    const winFlag = run.win;
    const lastSeg = run.segments[run.segments.length - 1];
    // Encode the whole run as ONE multi-segment card at the VALIDATED wire regime:
    // y=NEUTRAL_SPIN_Y (28.6, on 100% of real mid-game cards); each segment's s is the
    // lock state AT that shot; the tail &stripes: is the FINAL lock state. NO &move (a
    // GamePigeon-internal hint, not turn/foul logic) and NO &o (Bot only emits LEGAL
    // shots, so it never grants the tester ball-in-hand). See the TURN / FOUL ENCODING block.
    const newReplay = buildRunReplay({
        segments: run.segments.map((sg) => ({ d: sg.d, x: sg.x, y: sg.y, p: sg.p, s: sg.s })),
        pre: preBalls, post: run.finalPost, stripes: run.outStripes,
        win: winFlag,
    });

    const gs = poolGameplayState(state, { player, botUuid, botAvatar });
    const newState: PoolState = { ...gs, replay: newReplay };
    if (winFlag && botUuid) {
        // Winner flags are relative to `sender` across GamePigeon: 1=sender won,
        // -1=sender lost. The player slot is NOT the flag (player 2 previously
        // emitted "|2", which the watcher could not classify as a win).
        newState.winner = botUuid + '|1';
    }

    const claim = run.claim;                              // object balls potted across the run
    const pots = run.segments.filter((s) => s.isPot).length;
    const shots = run.segments.length;
    const endsOn = winFlag ? 'WIN' : lastSeg.isPot ? 'pot' : 'miss';
    return {
        ...base,
        action: ENABLE_SEND ? 'play' : 'skip',
        reason: ENABLE_SEND ? undefined
            : 'run built OK (' + shots + ' shot' + (shots === 1 ? '' : 's') + ', potted ' +
              JSON.stringify(claim) + ', ends on ' + endsOn + ', cueMargin=' +
              run.cueMargin.toFixed(0) + 'px) but GP_POOL_SEND unset (observe-only)',
        newState, player, opponent, aim: run.segments[0].d, factor,
        planned: {
            kind: shots > 1 ? 'run' : run.segments[0].kind,
            shots, pots, claim, claim8: winFlag,
            firstContact: run.firstContact, cueMargin: run.cueMargin,
            oppBallInHand, botSuit: run.botSuit, stripes: run.outStripes, win: winFlag,
            endsOn,
            segments: run.segments.map((s) => ({ kind: s.kind, target: s.target, p: s.p, claim: s.claim,
                endDist: s.endDist != null ? Math.round(s.endDist) : undefined })),
        },
    };
}

export const poolPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    solve,
    decideMove,
    engineReady,
    // exported for the dry-run harness / tests
    parseReplay, buildReplay, buildRunReplay, entriesToBalls, ballToEntry,
    legalTargetsFor, safetyCheck, botSlot, poolGameplayState, suitTargets, buildInvite,
    standardRack, buildBreakThroughEngine, pickRealBreak, REAL_BREAKS,
    selectStraightShot, planRun, inferBotSuit, findPots, findSafeShots, findNearMisses,
    potConfidence, straightCandidates, resolveLegal, legalOutcome, simStraight,
    buildPostFromReal, validateCardReal, toRealInput, nearestPocketDist,
    SOLIDS, STRIPES, ENABLE_SEND,
    NEUTRAL_SPIN_Y, SHOT_POWERS, EASY_POT_CUT, MAX_POT_TP, MIN_CUE_POCKET_MARGIN,
    RUN_MAX_SHOTS, BREAK_AIM, BREAK_POWERS, POT_POWERS, POT_AIM_SWEEP, POT_MAX_CUT, POT_MAX_TP,
    POT_MIN_ROBUSTNESS, POT_CONTINUATION_MAX_CUT, POT_CONTINUATION_MAX_TP,
    POT_ROBUSTNESS_AIM_OFFSETS, POT_ROBUSTNESS_POWER_MULTIPLIERS,
    MAX_DECLINE, DECLINE_RAMP_SHOTS, NEAR_MISS_RATTLE_PX,
};

