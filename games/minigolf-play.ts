// games/minigolf-play.ts
import type { ExtraContextRead, ExtraDecision, GolfSolveRead, GolfPlanRead, EaseAuditRow } from './play-extra-types.ts';
import type { PlayStateRead, PlayAdaptiveRead } from './play-types.ts';
import type { GolfMap, GolfStroke, Point2, Random } from './engine-types.ts';
import { minigolfEngine as engine } from './minigolf-engine.ts';   // faithful WASM map-gen + physics + planner
import { rubberBand as rb } from './rubber-band.ts';
import { fairPlay as fair } from './fair-play.ts';
// =============================================================================
// GamePigeon Mini Golf auto-play (game=golf) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map + the other
// *-play.ts modules):
//   game        : 'golf'
//   displayName : 'Mini Golf'
//   solve(state, deps)            -> ctx | null   (null => fail-safe skip)
//   decideMove(state, ctx, solve) -> { action, newState, ... }
//
// It regenerates the current hole's course from `seed` + `mode` with the faithful
// WASM engine (minigolf-engine.ts -> minigolf-real-engine.ts: GamePigeon's own
// Box2D + GolfMapGenerator compiled to WebAssembly), plans a stroke sequence that
// engine CERTIFIES sinks the ball end-to-end AND is robust under perturbation,
// appends the segment to Bot's replay field, and re-emits the card. The RECIPIENT
// REGENERATES the same course and RE-SIMULATES every shot; the ball must actually
// drop on their device for the hole to register, so the map generator + physics
// must match theirs (they now do) and the chosen line must be wide-basin enough to
// survive the small engine divergence. Same faithful-WASM doctrine as pool-play.ts.
//
// -------------------------------- TURN MODEL ---------------------------------
// The inviter takes slot player2; the invitee is player1. Each hole is played by
// P1 first, then P2. Bot's playable hole = the FIRST hole index where BOT's
// own replay has no segment, provided every earlier hole has segments from BOTH
// players (mirrors OpenPigeon's firstLocalPlayableHoleForIncomingData). `num` on
// an outgoing play = 2 + (first hole not complete for both, evaluated AFTER our
// strokes are added), capped at holeCount+1. This reproduces the real observed
// sequence: invite num=1, P1-hole0 num=2, P2-hole0 num=3.
//
// ------------------------------- SCORING/FINISH -------------------------------
// Total strokes across all holes, FEWER wins. When Bot plays the final missing
// segment we send segments + num=holeCount+1 and NO winner field (the opponent's
// client emits the winner echo). When Bot RECEIVES a card that is already
// complete for both players, or that carries a `winner`, we return the 'result'
// action so the watcher records W/L and sends nothing.
//
// ============================ VERIFICATION STATUS ============================
// WASM engine validated against the tester's REAL GamePigeon captures
// (production research notes, not included): re-simulating real human replays reproduces
// their hole-outs to sub-pixel where the map/physics is exercised directly (4/9
// full multi-shot chains to <=1.4px; the rest diverge only by compounding over
// long chains of the humans' own knife-edge shots - SUn2 hole0 reproduces P2's
// sink to 1.4px on the SAME map P1 misses on, proving the course is exact). The
// old hand-rolled engine reproduced 0/9 (250-374px off).
//
// The planner (engine.planHole) BFS-navigates the maze and returns the plan with
// the best END-TO-END robustness (engine.certifyPlan re-sims the whole line under
// perturbation). Self-check across many seeds/holes (modes 3 and 5): 100% hole
// out within a sane stroke count (optimal 1-4; eased up to MAX_STROKES), plans
// round-trip through the cipher. easeToStrokes weakens Bot like a HUMAN: each
// eased stroke UNDER-HITS the intended leg (same heading ±~7°, reduced power) and
// must strictly ADVANCE toward the cup, then a certified finish is re-planned from
// the true rest; it degrades GRACEFULLY, returning the longest reproducible eased
// plan it can build. Every emitted line must additionally hole out on a DEDICATED
// replay-only verifier WASM instance (engine.coldReplay) - the recipient's ground
// truth, immune to the warm planning-state contamination that shipped a no-sink
// hole on 2026-07-09 - or it is repaired/replaced before sending.
//
// SEND IS GATED (env GP_MINIGOLF_SEND=1 to arm), like pool/word-bites: the module
// BUILDS + logs the full reply on every turn but returns action:'skip' until the
// flag is set for the tester's live test.
// =============================================================================

const GAME_ID = 'golf';
const DISPLAY_NAME = 'Mini Golf';
const ENABLE_SEND = process.env.GP_MINIGOLF_SEND === '1';

// Prewarm the WASM engine at require time (fire-and-forget); decideMove is sync,
// so it gates on engine.ready() and skips the rare card that lands before the
// WASM finishes loading, exactly like pool-play.ts. Warm-up is a few hundred ms.
engine.load().catch(() => { /* first ensureHole re-checks ready() */ });
function engineReady() { try { return engine.ready(); } catch (_) { return false; } }

const MAX_STROKES = 9; // hard cap per hole on Bot's OWN cards (a genuinely weak
// player realistically scrapples to ~8-9 on a bad hole; raised from 8 so the eased
// target no longer CLIPS on par-3/4 holes - optimal 3-4 + extras used to hit the
// old cap of 8 and silently lose ~2 of the intended extra strokes).

// Keys that describe the invite chrome only; never echoed on a play card.
const INVITE_KEYS = ['start', 'caption', 'subcaption', 'game_name'];

// -----------------------------------------------------------------------------
// slotFor(state, botUuid) - which player slot is Bot?
//   player1 === bot -> 1;  player2 === bot -> 2;  else claim the open slot
//   (invitee takes slot 1 if player1 is empty). Returns 1|2 or null if both
//   slots are taken by other uuids (not Bot's game).
// -----------------------------------------------------------------------------
function slotFor(state: unknown, botUuid: unknown) {
    const p1 = (((state as PlayStateRead).player1 || '') as string).trim();
    const p2 = (((state as PlayStateRead).player2 || '') as string).trim();
    if (botUuid && p1 === botUuid) return 1;
    if (botUuid && p2 === botUuid) return 2;
    if (!p1) return 1;   // fresh invite: Bot is the invitee -> slot 1
    if (!p2) return 2;
    return null;         // both slots taken by others
}

// -----------------------------------------------------------------------------
// firstPlayableHole(state, slot) - the first hole index Bot may play now, or
// null if it is not Bot's turn / the game is complete. Ported from OpenPigeon's
// firstLocalPlayableHoleForIncomingData: Bot's replay lacks the hole AND all
// earlier holes have BOTH players' segments.
// -----------------------------------------------------------------------------
function firstPlayableHole(state: unknown, slot: number, holeCount: number) {
    const p1 = engine.parseReplay((state as PlayStateRead).replay);
    const p2 = engine.parseReplay((state as PlayStateRead).replay2);
    const mine = slot === 1 ? p1 : p2;
    const has = (arr: unknown[][], h: number) => !!arr[h] && arr[h].length > 0;
    for (let h = 0; h < holeCount; h++) {
        if (has(mine, h)) continue;
        let priorComplete = true;
        for (let p = 0; p < h; p++) {
            if (!(has(p1, p) && has(p2, p))) { priorComplete = false; break; }
        }
        return priorComplete ? h : null;
    }
    return null; // Bot has every hole
}

// gameComplete - both players have all holeCount segments.
function gameComplete(state: unknown, holeCount: number) {
    const p1 = engine.parseReplay((state as PlayStateRead).replay);
    const p2 = engine.parseReplay((state as PlayStateRead).replay2);
    for (let h = 0; h < holeCount; h++) {
        if (!(p1[h] && p1[h].length && p2[h] && p2[h].length)) return false;
    }
    return true;
}

// totalStrokes(replay, holeCount) - sum of a player's segment stroke counts.
function totalStrokes(replay: unknown, holeCount: number): unknown {
    const segs = engine.parseReplay(replay);
    let n = 0;
    for (let h = 0; h < holeCount; h++) if (segs[h]) n += segs[h].length;
    return n;
}

// -----------------------------------------------------------------------------
// difficultyStrokeTarget - map the shared rubber-band factor onto how many
// strokes Bot actually takes vs. the optimal plan, decided PER PLANNED STROKE.
// Higher factor (harder for the user) => fewer flubs; lower factor => more
// (easeToStrokes turns each flub into a real under-hit lag stroke) so the user
// can win.
//
// WHY PER-SHOT (2026-07-10 rewrite): the old map drew ONE extra-stroke count per
// hole (fair.extraCount, rng keyed (seed, holeIndex), mean wildness*6 with only a
// ±1 bump of variance), so sloppiness was uniform WITHIN a round - factor 0.60
// gave +5/+6/+5, factor 1.30 gave +0/+0/+0 - and as the adaptive factor walked
// between games the tester saw a lobotomy round, then a god round (the all-or-nothing
// oscillation). Now every planned stroke is its own flub check, rng keyed
// (seed, holeIndex, strokeIdx): a leg flubs (costs one honest extra lag stroke)
// with probability scaled by wildness, and an independent second draw lets a bad
// leg cost two (a real player sometimes needs two lag putts). Extra strokes vary
// shot to shot and hole to hole (some holes clean, some +2) with a moderate mean
// - floor ~+1-3/hole, mid-band ~+1-2/hole, ceiling mostly clean - so consecutive
// rounds land within a couple of strokes of each other. Deterministic per
// (seed, hole, leg) and MONOTONE in the factor: the same rng draws are compared
// against wildness-scaled thresholds, so a lower factor can only ADD flubs.
// -----------------------------------------------------------------------------
const FLUB_P1 = 0.62;  // per-leg flub probability at wildness 1 (the adaptive floor)
const FLUB_P2 = 0.53;  // independent second-draw probability at wildness 1 (leg costs +2)
// Widest number of EXTRA lag strokes a maximally-eased Bot tacks onto one hole
// (the per-hole target is additionally clamped to MAX_STROKES by the caller).
const EASE_MAX_EXTRA_PER_HOLE = 4;
function difficultyStrokeTarget(optimal: number, factor: number, seed: unknown, holeIndex: number): unknown {
    const w = fair.wildness(fair.factorToSkill((factor as number)));
    const cap = Math.max(0, Math.min(EASE_MAX_EXTRA_PER_HOLE, MAX_STROKES - optimal));
    let extra = 0;
    for (let i = 0; i < optimal && extra < cap; i++) {
        const rng = fair.mulberry32(fair.hashSeed(seed, holeIndex, i, 'flub'));
        if (rng() < w * FLUB_P1) extra++;
        if (extra < cap && rng() < w * FLUB_P2) extra++;
    }
    return optimal + extra;
}

// -----------------------------------------------------------------------------
// easeToStrokes - realise a weaker round that takes MORE real, reproducible strokes
// and STILL holes out, using UNDER-HIT LAG STROKES only.
//
// WHY THE OLD SCATTER EASER DIED (2026-07-10): weakShot used to spray candidate
// headings up to ±69° off the corridor and accepted any stroke that merely MOVED
// ≥12px - displacement, not progress, so a wall bounce-back qualified. On-device
// that read as Bot firing sideways/away from the cup, oscillating in a pocket,
// then finishing with two laser shots (the tester's "random directions" complaint).
//
// MODEL: a flubbed stroke is the intended leg UNDER-HIT, like a human leaving a
// putt short. Same heading within ±EASE_MAX_ANG_ERR (~7°, triangular so usually
// much less), power scaled to 0.55–0.85 of the intended leg and never above it
// (no wall-slams), and it must genuinely ADVANCE: really roll ≥EASE_MIN_MOVE px,
// end ≥EASE_MIN_ADVANCE px CLOSER to the cup, and not sink. A leg that cannot be
// under-hit within those rules (e.g. a bank leg where stopping short means no
// progress) is played AS PLANNED and the next leg is tried instead - easing never
// emits a sideways, backward, or oscillating stroke, period. After every flub the
// finish is re-planned from the ball's true rest (engine.planFromPos - a maze-
// navigating certified sink with a fast close-range direct-putt path).
//
// GRACEFUL DEGRADATION (kept from the previous easer - the delivery fix): at every
// step the running sequence (committed strokes + current certified finish) is
// finalized to wire precision and, if it holes out nominally and clears the certify
// bar, remembered as the LONGEST valid eased plan so far. If `target` can't be
// reached we return the longest valid plan we DID reach - never collapsing back to
// the tight optimal line just because the deepest target didn't certify - so the
// DELIVERED extra strokes track difficultyStrokeTarget. Every recorded plan is
// finalizePlan-certified to hole out; a weaker Bot takes more REAL strokes.
// -----------------------------------------------------------------------------
const EASE_MAX_ANG_ERR = 0.12; // rad (~7°): max heading error of a flub vs the intended leg
const EASE_POWER_LO = 0.55;    // flub power = intended leg power x [LO, HI] - under-hit only
const EASE_POWER_HI = 0.85;
const EASE_MIN_MOVE = 20;      // a flub must really roll (px) - no dead taps
const EASE_MIN_ADVANCE = 15;   // ...and end at least this much CLOSER to the cup (px)
// An eased round must still re-sim (hole out) at least this often under end-to-end
// jitter. RAISED back from the scatter era's 0.30: on-line under-hits certify easily
// (they ride the same corridor the certified finish does), so the permissive bar the
// ±69° scatter strokes needed is gone.
const EASE_MIN_CERT = 0.5;
const MAX_EASE_STEPS = 8;      // cap the walk; each step commits ONE stroke and runs at
// most one fast re-plan (engine.planFromPos direct-putt path), so deep targets stay cheap.
const WEAK_DRAWS = 8;          // rng draws per flub attempt before giving up on that leg

// _easeAudit - per-flub {hole, angErr, frac, advance} for the LAST easeToStrokes call.
// Harness/debug hook only (exported as _debugEaseAudit); no decision logic reads it.
let _easeAudit: EaseAuditRow[] = [];

// weakShot - ONE deliberately-under-hit lag stroke along the intended leg (see the
// model above). Returns { dist, rotation, pos } or null if this leg can't be flubbed
// without breaking the advance rules. `prev` is the previously committed stroke - a
// candidate within (2px, 0.02rad) of it is rejected so eased holes never show the
// identical-repeat-tap look. Deterministic via rng.
function weakShot(map: GolfMap, from: Point2, leg: GolfStroke, cup: Point2, prev: GolfStroke | null, rng: Random) {
    const dBefore = Math.hypot(cup.x - from.x, cup.y - from.y);
    for (let draw = 0; draw < WEAK_DRAWS; draw++) {
        const rot = leg.rotation + fair.bipolar(rng) * EASE_MAX_ANG_ERR;
        const dp = Math.min(engine.AIM_MAX_DIST,
            leg.dist * (EASE_POWER_LO + rng() * (EASE_POWER_HI - EASE_POWER_LO)));
        if (prev && Math.abs(dp - prev.dist) < 2 && Math.abs(rot - prev.rotation) < 0.02) continue;
        const r = engine.simulateShot(map, null, from.x, from.y, dp, rot, {});
        if (r.sunk) continue;                                             // a flub must not sink
        if (Math.hypot(r.pos.x - from.x, r.pos.y - from.y) < EASE_MIN_MOVE) continue;
        const advance = dBefore - Math.hypot(cup.x - r.pos.x, cup.y - r.pos.y);
        if (advance < EASE_MIN_ADVANCE) continue;                         // must genuinely get closer
        _easeAudit.push({ hole: map.holeIndex, dist: dp, rotation: rot,
            angErr: rot - leg.rotation, frac: dp / (leg.dist || 1), advance });
        return { dist: dp, rotation: rot, pos: r.pos };
    }
    return null;
}

function easeToStrokes(map: GolfMap, _colliders: unknown, slot: number, basePlan: unknown, target: number, seed: unknown, holeIndex: number): unknown {
    _easeAudit = [];
    if (!basePlan || !(basePlan as GolfPlanRead).sunk || !(basePlan as GolfPlanRead).strokes.length) return basePlan;
    const optimal = (basePlan as GolfPlanRead).strokes.length;
    if (!(target > optimal)) return basePlan;
    const tee = slot === 2 ? map.ballStart2 : map.ballStart1;
    const cup = map.hole;
    const rng = fair.mulberry32(fair.hashSeed(seed, holeIndex, target, 'ease'));

    let best = basePlan;            // fallback floor: the tight plan (always legal)
    let bestLen = optimal;
    const record = (committed: GolfStroke[], fin: GolfPlanRead) => {
        const raw = committed.concat(fin.strokes);
        if (raw.length <= bestLen || raw.length > MAX_STROKES) return false;
        const finalized = (engine.finalizePlan(map, slot, raw) as GolfStroke[]);   // guarantees a nominal hole-out
        if (!finalized || finalized.length <= bestLen || finalized.length > MAX_STROKES) return false;
        if (engine.certifyPlan(map, slot, finalized) < EASE_MIN_CERT) return false;
        best = { sunk: true, strokes: finalized };
        bestLen = finalized.length;
        return true;
    };

    // Walk the hole ONE stroke at a time: flub the current finish's first leg when the
    // advance rules allow it, otherwise play that leg as planned and try the next.
    let pos = { x: tee.x, y: tee.y };
    const committed: GolfStroke[] = [];           // locked-in strokes (flubs + as-planned legs)
    let fin: GolfPlanRead = (basePlan as GolfPlanRead);             // certified finish from `pos` (from the tee initially - free)
    for (let step = 0; step < MAX_EASE_STEPS; step++) {
        // Record committed+finish as the best-so-far, and stop once we hit target.
        if (record(committed, fin) && bestLen >= target) return best;
        if (committed.length + fin.strokes.length >= target) break;   // long enough already
        if (committed.length >= MAX_STROKES - 1) break;               // must leave room to finish
        const leg = fin.strokes[0];
        const flub = weakShot(map, pos, leg, cup, committed[committed.length - 1] || null, rng);
        if (flub) {
            committed.push({ dist: flub.dist, rotation: flub.rotation });
            pos = { x: flub.pos.x, y: flub.pos.y };
            const budget = MAX_STROKES - committed.length;
            if (budget < 1) break;
            fin = (engine.planFromPos(map, slot, pos, budget) as GolfPlanRead);         // re-plan from the true rest
            if (!fin.sunk || !fin.strokes.length) break;              // can't finish -> keep best
        } else if (fin.strokes.length > 1) {
            // This leg can't be under-hit without giving up real progress - play it as
            // planned and ease a LATER leg (the remainder of `fin` is that same plan's
            // already-certified continuation from this exact rest).
            const r = engine.simulateShot(map, null, pos.x, pos.y, leg.dist, leg.rotation, {});
            if (r.sunk) break;
            committed.push({ dist: leg.dist, rotation: leg.rotation });
            pos = { x: r.pos.x, y: r.pos.y };
            fin = { sunk: true, strokes: fin.strokes.slice(1) };
        } else {
            break; // the finish is a single unflubbable sinking putt - nothing left to ease
        }
    }
    record(committed, fin);         // final attempt with the last planned finish
    return best;
}

// -----------------------------------------------------------------------------
// catchupExtraStrokes - WITHIN-GAME catch-up for a 3/5-hole round. Reads the running
// stroke totals on holes BOTH players have already finished and returns a SIGNED nudge
// to the base stroke target for the holes still to play: ahead (fewer strokes) => take
// a few MORE real strokes; behind => shave a few OFF the base sloppiness (play tighter).
//
// SYMMETRIC + BOUNDED (the asymmetry fix). The old version was lopsided: "ahead -> ease"
// was capped by how much the eased plan could deliver, while "behind -> play OPTIMAL"
// was unbounded full strength. Against a weak player that meant every time the ease
// accidentally put Bot behind, the very next hole snapped to a flawless line and clawed
// the game back - a net over-win the capped ease could never balance. Now BOTH sides are
// the same bounded ±CATCHUP_MAX strokes, so the nudge CENTERS the margin instead of
// ratcheting Bot's win rate up. The caller clamps the target to >= optimal, so a behind
// Bot pushes toward its best but can NEVER be flipped into throwing (adding strokes).
// Honest: it changes how many REAL strokes Bot takes, never a faked score. Off at a
// pinned try-hard difficulty (sweat/max). Returns { extra } (signed).
// -----------------------------------------------------------------------------
const CATCHUP_MAX = 1;     // bounded within-game nudge, symmetric either way (strokes).
// SHRUNK 3 -> 1 (2026-07-10): a ±3 swing amplified the within-game snap - behind ->
// jump to near-optimal, ahead -> +3 sloppier - which read as the same god-mode/lobotomy
// oscillation the per-shot flub variance was built to kill. ±1 still centers the margin
// (an ahead Bot takes one more honest lag stroke per hole) without visible mode flips.
// Strokes/hole lead that maps to the FULL nudge. Higher = LESS sensitive, so a modest
// lead vs a competitive opponent doesn't trigger a big give-back (which flips would-be
// wins into losses); the full ease only fires on the BIG leads Bot piles up vs a weak
// player. This is the knob that keeps a near-even (average) opponent centered while a
// weak opponent still gets eased hard.
const CATCHUP_SCALE = 3.5;
function catchupExtraStrokes(state: unknown, slot: number, holeIndex: number, holeCount: number, difficulty: unknown) {
    if (difficulty === 'sweat' || difficulty === 'max') return { extra: 0 };
    if (holeIndex < 1) return { extra: 0 }; // no completed hole to compare yet
    const mineSeg = engine.parseReplay(slot === 1 ? (state as PlayStateRead).replay : (state as PlayStateRead).replay2);
    const oppSeg = engine.parseReplay(slot === 1 ? (state as PlayStateRead).replay2 : (state as PlayStateRead).replay);
    let mine = 0, opp = 0;
    for (let h = 0; h < holeIndex; h++) {
        if (mineSeg[h]) mine += mineSeg[h].length;
        if (oppSeg[h]) opp += oppSeg[h].length;
    }
    if (opp === 0) return { extra: 0 }; // opponent hasn't finished a comparable hole
    const holesLeft = Math.max(1, holeCount - holeIndex); // including this hole
    const lead = opp - mine;                              // + => Bot ahead (fewer strokes)
    const perHole = lead / holesLeft;
    const sig = fair.catchupSignal(perHole, CATCHUP_SCALE); // full nudge at CATCHUP_SCALE strokes/hole lead
    return { extra: Math.round(sig * CATCHUP_MAX) };        // +ahead => more strokes; -behind => fewer (bounded)
}

// -----------------------------------------------------------------------------
// coldRepair - the honesty guarantee. engine.coldReplay now runs on the engine's
// DEDICATED VERIFIER WASM instance: a replay-only module that regenerates the
// course and re-sims the exact wire strokes precisely the way the recipient's
// device does. (The old main-world regen-replay was believed deterministic, but
// accumulated Box2D/WASM state after thousands of planning sims produced a false
// "sunk" on 2026-07-09 - the emitted 4-stroke hole missed by 327px on the tester's
// device and never dropped. The verifier cannot accumulate that state, and is
// refreshed after every emitted turn.) This takes any candidate stroke list and
// returns a version PROVEN to hole out on the verifier, or null:
//   * verifier replay sinks -> return the strokes trimmed at the sinking shot;
//   * verifier replay misses -> re-plan a certified finish from the ball's TRUE
//     verified rest (engine.planFromPos on the main planning world), append, and
//     re-verify - bounded attempts, never exceeding MAX_STROKES (drop the failed
//     tail stroke to make room when full; an EMPTY input builds a fresh verified
//     line from the tee).
// Repairs only ever ADD real strokes (or trim dead ones after a sink), so a
// repair can cost Bot a stroke but can never fake one - erring on the honest,
// opponent-friendly side. Every emitted card holes out on the recipient, period.
// -----------------------------------------------------------------------------
const COLD_REPAIR_ATTEMPTS = 4;
function coldRepair(map: GolfMap, slot: number, strokes: unknown): unknown {
    let S = strokes ? (strokes as GolfStroke[]).slice() : [];
    for (let attempt = 0; attempt < COLD_REPAIR_ATTEMPTS; attempt++) {
        const cr = engine.coldReplay(map, slot, S);
        if (cr.sunk) return S.slice(0, cr.sunkAt + 1); // trim dead strokes after the sink
        if (S.length >= MAX_STROKES) { S = S.slice(0, MAX_STROKES - 1); continue; } // free room for a finish
        const fin: GolfPlanRead = (engine.planFromPos(map, slot, cr.rest, MAX_STROKES - S.length) as GolfPlanRead);
        if (!fin.sunk || !fin.strokes.length) {
            if (!S.length) return null; // can't even plan from the tee
            S = S.slice(0, -1); continue; // boxed in -> back off a stroke
        }
        S = S.concat(fin.strokes.map((s) => ({ dist: s.dist, rotation: s.rotation })));
    }
    return null;
}

// =============================================================================
// solve(state, deps) - parse the card + regenerate the current course. Returns a
// context object, or null ONLY on a malformed / unreadable card.
// =============================================================================
function solve(state: unknown, _deps: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return null;
    const mode = engine.normalizeMode((state as PlayStateRead).mode || (state as PlayStateRead).subcaption || '3');
    const holeCount = engine.holeCountFor(mode);
    if (!Number.isFinite(holeCount) || holeCount < 1) return null;
    const seedRaw = (state as PlayStateRead).seed;
    if (seedRaw == null || seedRaw === '') return null;
    const seed = parseInt((seedRaw as string), 10);
    if (!Number.isFinite(seed)) return null;
    return { mode, holeCount, seed };
}

// =============================================================================
// decideMove(state, ctx, solveResult)
//   ctx = { botUuid, botAvatar, rbState }
// Returns { action:'ignore'|'skip'|'result'|'play', ... }.
// =============================================================================
function decideMove(state: unknown, ctx: unknown, solveResult: unknown): ExtraDecision {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return { action: 'ignore' };
    const botUuid = ctx && (ctx as ExtraContextRead).botUuid;
    const botAvatar = ctx && (ctx as ExtraContextRead).botAvatar;
    const rbState = (((ctx && (ctx as ExtraContextRead).rbState) || {}) as PlayAdaptiveRead);

    const sr = solveResult || solve(state, {});
    if (!sr) return { action: 'ignore' };
    const { mode, holeCount, seed } = (sr as GolfSolveRead);

    // Bot's own echoed card -> ignore (don't reply to ourselves).
    if (botUuid && (state as PlayStateRead).sender === botUuid && !(state as PlayStateRead).winner) return { action: 'ignore' };

    const slot = slotFor(state, botUuid);
    if (slot == null) return { action: 'ignore' };
    const opponent = slot === 1 ? 2 : 1;

    // --- finished game: winner present, or both players complete ------------
    if ((state as PlayStateRead).winner || gameComplete(state, holeCount)) {
        const myStrokes = totalStrokes(slot === 1 ? (state as PlayStateRead).replay : (state as PlayStateRead).replay2, holeCount);
        const oppStrokes = totalStrokes(slot === 1 ? (state as PlayStateRead).replay2 : (state as PlayStateRead).replay, holeCount);
        let botWon = null;
        if ((state as PlayStateRead).winner) {
            const parts = String((state as PlayStateRead).winner).split('|');
            const flag = parts[1];
            if (flag === '0') botWon = null;
            else {
                const senderWon = flag === '1';
                const senderIsBot = (state as PlayStateRead).sender === botUuid;
                botWon = senderIsBot ? senderWon : !senderWon;
            }
        } else if ((myStrokes as number) > 0 && (oppStrokes as number) > 0) {
            botWon = (myStrokes as number) < (oppStrokes as number) ? true : (myStrokes as number) > (oppStrokes as number) ? false : null;
        }
        return { action: 'result', botWon, botScore: myStrokes, oppScore: oppStrokes };
    }

    // --- whose turn / which hole -------------------------------------------
    const holeIndex = firstPlayableHole(state, slot, holeCount);
    if (holeIndex == null) return { action: 'ignore' }; // not Bot's turn

    // --- WASM engine must be warm before we can generate/simulate ----------
    if (!engineReady()) {
        return { action: 'skip', reason: 'mini golf engine warming up (WASM not loaded)',
            mode: 'golf', botScore: 0, botWords: 0 };
    }

    // --- plan the hole ------------------------------------------------------
    const map = engine.createMap(seed, holeIndex, mode);
    const colliders = engine.buildColliders(map);
    const basePlan = (engine.planHole(map, slot, { maxStrokes: MAX_STROKES }) as GolfPlanRead);
    let plan: GolfPlanRead = basePlan;

    // difficulty: ease the sunk plan toward a stroke target above the optimum so a
    // below-strength Bot genuinely takes more (real, reproducible) strokes - every
    // eased stroke an under-hit lag along the intended line that strictly advances
    // toward the cup (see easeToStrokes). The target = per-shot flub count from the
    // adaptive/fixed factor + WITHIN-GAME catch-up (a SIGNED, symmetric, ±1 nudge:
    // one more lag stroke when ahead, tighter - but never below optimal - when
    // behind). easeToStrokes degrades gracefully: it returns the LONGEST reproducible
    // eased plan it can build, collapsing to the tight plan only if nothing longer
    // certifies, so the recipient always reproduces the hole-out.
    const factor = rb.handicapFactor(rbState);
    if ((basePlan as GolfPlanRead).sunk) {
        const optimal = (basePlan as GolfPlanRead).strokes.length;
        const baseTarget = difficultyStrokeTarget(optimal, factor as number, seed, holeIndex);
        const cu = catchupExtraStrokes(state, slot, holeIndex, holeCount, rbState.difficulty);
        // cu.extra is signed (ahead: +, behind: -); clamp to [optimal, MAX_STROKES] so a
        // behind Bot pushes toward its best but is never flipped into throwing.
        const target = Math.max(optimal, Math.min(MAX_STROKES, (baseTarget as number) + cu.extra));
        if (target > optimal) {
            plan = (easeToStrokes(map, colliders, slot, basePlan, target, seed, holeIndex) as GolfPlanRead);
        }
    }
    if (!plan.strokes || plan.strokes.length === 0) {
        return { action: 'skip', reason: 'planner produced no strokes', mode: 'golf',
            botScore: 0, botWords: 0 };
    }
    // Wire-safety: emit the exact %.6f shots that will be sent, guaranteed to hole
    // out nominally (rounding can tip a knife-edge shot from sink to miss).
    plan = { sunk: plan.sunk, strokes: (engine.finalizePlan(map, slot, plan.strokes) as GolfStroke[]) };

    // VERIFIER honesty gate + repair (see coldRepair): every emitted plan must hole
    // out on the dedicated replay-only verifier instance - the recipient's ground
    // truth. Tiers: repair the (possibly eased) plan -> repair the tight base plan ->
    // build a fresh verified line from the tee. NEVER emit an unverified warm plan:
    // that fallback is exactly what shipped the 2026-07-09 hole that fired 4 strokes
    // and never dropped. If no tier certifies (unobserved), skip the turn - the
    // watcher will retry on the next poll with a fresh verifier.
    let safe = coldRepair(map, slot, plan.strokes);
    if (!safe) {
        const baseWire = (engine.finalizePlan(map, slot, (basePlan as GolfPlanRead).strokes) as GolfStroke[]);
        if (engine.strokesToSegment(baseWire) !== engine.strokesToSegment(plan.strokes)) {
            safe = coldRepair(map, slot, baseWire);
        }
    }
    if (!safe) safe = coldRepair(map, slot, null); // fresh verified line from the tee
    if (!safe) {
        return { action: 'skip', reason: 'verifier could not certify any sinking line for hole ' + holeIndex,
            mode: 'golf', botScore: 0, botWords: 0 };
    }
    plan = { sunk: true, strokes: (safe as GolfStroke[]) };
    engine.refreshVerifier(); // pristine verifier for the next turn (fire-and-forget)

    // --- build the outgoing card -------------------------------------------
    const myReplayField = slot === 1 ? 'replay' : 'replay2';
    const updatedReplay = engine.appendSegment((state as PlayStateRead)[myReplayField], holeIndex, plan.strokes);
    const roundStrokes = totalStrokes(updatedReplay, holeCount);

    const newState: PlayStateRead = Object.assign({}, state);
    for (const k of INVITE_KEYS) delete newState[k];
    newState.game = GAME_ID;
    newState.version = (state as PlayStateRead).version || '41';
    newState.v3 = (state as PlayStateRead).v3 || '3';
    newState.v2 = (state as PlayStateRead).v2 || '2';
    newState.mode = mode;
    newState.seed = String((state as PlayStateRead).seed);
    newState.sender = botUuid;
    newState.player = String(slot);
    newState[myReplayField] = updatedReplay;
    newState['player' + slot] = botUuid;
    if (botAvatar) newState['avatar' + slot] = botAvatar;

    // num = 2 + first hole not complete for both AFTER our strokes, cap holeCount+1.
    const nextIncomplete = (function () {
        const p1 = engine.parseReplay(newState.replay);
        const p2 = engine.parseReplay(newState.replay2);
        for (let h = 0; h < holeCount; h++) {
            if (!((p1[h] && p1[h].length) && (p2[h] && p2[h].length))) return h;
        }
        return holeCount;
    })();
    newState.num = String(Math.min(holeCount + 1, nextIncomplete + 2));

    const boardId = seed + '|' + mode + '|' + holeIndex;
    const optimalNote = plan.sunk ? 'sunk' : 'best-effort';

    const decision = {
        newState,
        player: slot,
        opponent,
        mode: 'golf',
        botScore: plan.strokes.length,   // strokes on this hole
        eventScore: roundStrokes,         // game-awareness note must report the running total, not just this hole
        oppScore: totalStrokes(slot === 1 ? (state as PlayStateRead).replay2 : (state as PlayStateRead).replay, holeCount),
        fullScore: plan.strokes.length,
        fullWords: plan.strokes.length,
        botWords: plan.strokes.length,
        targetN: holeIndex,
        boardId,
        note: optimalNote,
    };

    if (!ENABLE_SEND) {
        return Object.assign({ action: 'skip' as const,
            reason: 'GP_MINIGOLF_SEND not set (dry-run only); hole ' + holeIndex + ' planned ' + plan.strokes.length + ' strokes (' + optimalNote + ')' },
            decision);
    }
    return Object.assign({ action: 'play' as const }, decision);
}

export const minigolfPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    solve,
    decideMove,
    // helpers exposed for the dry-run harness
    slotFor,
    firstPlayableHole,
    gameComplete,
    totalStrokes,
    difficultyStrokeTarget,
    easeToStrokes,
    catchupExtraStrokes,
    MAX_STROKES,
    ENABLE_SEND,
    _debugEaseAudit: (): unknown[] => _easeAudit,
};

