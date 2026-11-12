// games/tanks-play.ts
import type { ExtraContextRead, ExtraDecision, TanksSolveRead } from './play-extra-types.ts';
import type { PlayStateRead, PlayAdaptiveRead } from './play-types.ts';
import { tanksPhysics as physics } from './tanks-physics.ts';
import { rubberBand as rb } from './rubber-band.ts';
// =============================================================================
// Tanks auto-play (game=tanks) - pure decision logic, no I/O
// =============================================================================
//
// Uniform registry interface (see watcher.ts GAMES map):
//   game        : 'tanks'
//   displayName : 'Tanks'
//   solve(state, deps) -> parsed board context | null (null => fail-safe skip)
//   decideMove(state, ctx, solve) -> { action, ... }
//
// Tanks is an AIM+POWER physics game: the reply carries MY tank's (rotation, power)
// + shoot:N and the RECIPIENT RE-SIMULATES the shot. So Bot must SOLVE for an
// aim+power that lands on the opponent (tanks-physics.solveAim). The rubber-band is
// applied as Gaussian NOISE on the solved aim (perfect when ramping up, a
// controlled near-miss when easing up).
//
// ============================ VERIFICATION STATUS ============================
// Physics constants are the OpenPigeon Frida measurements (tanks-physics.ts). BUT
// the board grammar (the `height` terrain model, tank y from terrain, rotation
// convention + zero-direction, wind sign, power range) is UNCONFIRMED - the dbs
// have NO Tanks capture. This is the HARD game: even with correct physics, if the
// rotation/wind conventions are off the re-simulated shot misses. FAIL-SAFE:
// solve() returns null (=> skip) unless the board yields two tanks with x, power,
// rotation, hp. SEND IS OBSERVE-GATED (GP_TANKS_SEND) and MUST STAY OFF until (a) a
// real capture confirms the grammar and (b) a supervised self-test confirms a
// solved shot actually connects on-device. Observe mode logs the parsed board + the
// solved aim + predicted miss distance so a capture can calibrate the conventions.
//
// CAPTURE CHECKLIST (what the tester must send to confirm before arming):
//   1. A Tanks INVITE - confirms game=, version, invite markers.
//   2. A MID-GAME card right after the OPPONENT shot (shoot:<opp>) - confirms the
//      replay field, the board k,v grammar, both tanks' x/rot/power/hp, wind, and
//      the `height`/terrain field. CRITICAL: it pins the rotation convention (which
//      way 0deg points, whether rot is 0..180 or signed) and the wind sign.
//   3. Ideally a card where a shot HIT (hp dropped) so the landing can be
//      back-solved to calibrate rotation/wind against the physics.
//   4. A FINISHED card - confirms winner encoding.
// Until these exist this module decodes + solves + round-trips in dry-run only.
// ============================================================================

const GAME_ID = 'tanks';
const DISPLAY_NAME = 'Tanks';

const ENABLE_SEND = process.env.GP_TANKS_SEND === '1';

function getSubtitle(msg: unknown, _myUuid: unknown) {
    if (msg && (msg as PlayStateRead).winner) {
        const parts = String((msg as PlayStateRead).winner).split('|');
        const u = parts[0];
        const flag = parts[1];
        let iWon = ((msg as PlayStateRead).sender === u);
        if (flag === '-1') iWon = !iWon;
        if (flag === '0') return 'Draw!';
        return iWon ? 'I won!' : 'You Won!';
    }
    return 'Your Move.';
}

// -----------------------------------------------------------------------------
// parseBoardKV(boardStr) -> { height, wind, tank1x, tank1rot, ... } numeric map.
// board segment is "k,v&k,v&..." (the part before the first `|`).
// -----------------------------------------------------------------------------
function parseBoardKV(boardStr: unknown) {
    const out: Record<string, unknown> = {};
    if (typeof boardStr !== 'string') return out;
    for (const pair of boardStr.split('&')) {
        if (!pair) continue;
        const i = pair.indexOf(',');
        if (i < 0) continue;
        const k = pair.slice(0, i).trim();
        const v = Number(pair.slice(i + 1).trim());
        if (k) out[k] = v;
    }
    return out;
}

// Parse the `replay` into { board (kv map), lastShoot (player|null) }.
function parseReplay(replay: unknown) {
    if (typeof replay !== 'string' || replay.length === 0) {
        return { board: null, lastShoot: null, ok: false };
    }
    // take the LAST board: segment (state advances board:...|shoot:...|board:...)
    const segs = replay.split('|');
    let boardStr = null;
    let lastShoot = null;
    for (const seg of segs) {
        if (seg.startsWith('board:')) boardStr = seg.slice('board:'.length);
        else if (seg.startsWith('shoot:')) {
            const p = Number(seg.slice('shoot:'.length));
            if (Number.isFinite(p)) lastShoot = p;
        }
    }
    if (boardStr == null) return { board: null, lastShoot, ok: false };
    return { board: parseBoardKV(boardStr), lastShoot, ok: true };
}

function looksLikeTanks(state: unknown) {
    if (!state || (state as PlayStateRead).game !== GAME_ID) return false;
    // a fresh invite may have no replay; a gameplay card must parse into 2 tanks
    if ((state as PlayStateRead).replay != null && typeof (state as PlayStateRead).replay === 'string' && ((state as PlayStateRead).replay as string).length > 0) {
        const p = parseReplay((state as PlayStateRead).replay);
        if (!p.ok || !p.board) return false;
        const b = p.board;
        const need = ['tank1x', 'tank1power', 'tank2x', 'tank2power'];
        if (need.some((k) => !Number.isFinite(b[k]))) return false;
    }
    return true;
}

// -----------------------------------------------------------------------------
// solve(state, deps) - parse the board + tanks. Returns { board, lastShoot } or
// null to skip. A fresh invite (no replay) can't be shot into yet -> returns a
// marker so decideMove can hand back the invite as a first-shot only if the board
// is present; otherwise it skips (Tanks needs terrain to aim).
// -----------------------------------------------------------------------------
function solve(state: unknown /*, deps */) {
    if (!looksLikeTanks(state)) return null;
    if (!(state as PlayStateRead).replay) {
        // fresh invite with no board: we cannot aim without terrain/positions.
        return { board: null, lastShoot: null, freshInvite: true };
    }
    const p = parseReplay((state as PlayStateRead).replay);
    if (!p.ok || !p.board) return null;
    return { board: p.board, lastShoot: p.lastShoot, freshInvite: false };
}

// -----------------------------------------------------------------------------
// factorToNoise(factor) - map the shared rubber-band factor onto aim noise (deg,
// power). ramp-up = strong-human (capped, not pinpoint); ease-up = a near-miss.
// -----------------------------------------------------------------------------
function factorToNoise(factor: number) {
    // Above the neutral band Bot sharpens toward the SKILL_CAP (strong human) but
    // NEVER to a pinpoint robot: ramp from ~pinpoint at factor 1.0 (match) up to a
    // small capped wobble at factor 1.30 (max), so a pinned max still misses some
    // shots instead of guaranteeing a hit. Below 1.0 the existing eased bands hold.
    if (factor >= 1.0) {
        const t = Math.min(1, Math.max(0, (Math.min(factor, 1.30) - 1.0) / 0.30));
        return { rotSigma: 0.5 * t, powerSigma: 0.006 * t, label: 'ramp-up:strong-human' };
    }
    if (factor >= 0.9) return { rotSigma: 1.5, powerSigma: 0.02, label: 'tie:tight' };
    if (factor >= 0.8) return { rotSigma: 4, powerSigma: 0.05, label: 'ease-up:loose' };
    return { rotSigma: 8, powerSigma: 0.1, label: 'new:wide-miss' };
}

// deterministic-ish small gaussian via Box-Muller (rng injectable for tests)
function gauss(sigma: number, rng: unknown) {
    if (sigma <= 0) return 0;
    const r = rng || Math.random;
    const u = Math.max(1e-9, (r as () => number)());
    const v = (r as () => number)();
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function decideMove(state: unknown, ctx: unknown, solveResult: unknown): ExtraDecision {
    if (!looksLikeTanks(state)) return { action: 'ignore' };
    const rbState = (((ctx && (ctx as ExtraContextRead).rbState) || {}) as PlayAdaptiveRead);

    if ((state as PlayStateRead).winner) {
        const parts = String((state as PlayStateRead).winner).split('|');
        const wUuid = parts[0];
        const flag = parts[1];
        let botWon;
        if (flag === '0') botWon = null;
        else {
            const senderWon = flag === '1';
            const senderIsBot = ((state as PlayStateRead).sender === (ctx as ExtraContextRead).botUuid);
            botWon = senderIsBot ? senderWon : !senderWon;
        }
        return { action: 'result', winner: wUuid, flag, botWon };
    }

    if (!solveResult) return { action: 'ignore' };
    if ((solveResult as TanksSolveRead).freshInvite) {
        // No terrain to aim at yet. Tanks needs the board before Bot can shoot.
        return { action: 'skip', reason: 'tanks: fresh invite has no board/terrain to aim into - waiting for the first gameplay card' };
    }

    // --- Whose turn is it? MULTI-TURN game: after Bot plays once, its uuid stays
    // in a slot for the rest of the game, so slot-ownership can NOT tell whose turn
    // it is. The reliable signal is state.sender = who sent THIS card. Bot only
    // ever sees INBOUND cards (is_from_me=0); if the sender is Bot it is an ECHO
    // of Bot's own move -> ignore. Otherwise the opponent just moved and it is
    // Bot's turn again, even when Bot already owns a slot from a prior turn.
    if ((state as PlayStateRead).sender && (state as PlayStateRead).sender === (ctx as ExtraContextRead).botUuid) {
        return { action: 'ignore' };
    }
    // Bot replies in the slot it already owns (subsequent turns); on the first
    // turn Bot takes the slot the opponent does NOT occupy (bare invite: the
    // inviter is player2, so Bot takes slot 1).
    let player;
    let opponent;
    if ((state as PlayStateRead).player1 === (ctx as ExtraContextRead).botUuid) { player = 1; opponent = 2; }
    else if ((state as PlayStateRead).player2 === (ctx as ExtraContextRead).botUuid) { player = 2; opponent = 1; }
    else if ((state as PlayStateRead).player1 && (state as PlayStateRead).player1 !== (ctx as ExtraContextRead).botUuid) { opponent = 1; player = 2; }
    else if ((state as PlayStateRead).player2 && (state as PlayStateRead).player2 !== (ctx as ExtraContextRead).botUuid) { opponent = 2; player = 1; }
    else { opponent = 2; player = 1; }

    const b = (solveResult as TanksSolveRead).board;
    const myX = b['tank' + player + 'x'];
    const myTerrainH = Number.isFinite(b.height) ? b.height : 0;
    const oppX = b['tank' + opponent + 'x'];
    const wind = Number.isFinite(b.wind) ? b.wind : 0;
    if (!Number.isFinite(myX) || !Number.isFinite(oppX)) {
        return { action: 'skip', reason: 'tanks: could not read tank x positions from board' };
    }
    // Muzzle origin: tank x + muzzle offset toward the opponent, at terrain height.
    // (y model is UNCONFIRMED; we place both tanks at the board height and let the
    // solver aim in that plane. A capture must confirm per-tank y.)
    const y0 = myTerrainH;
    const targetY = myTerrainH;
    const dir = oppX >= myX ? 1 : -1;
    const x0 = myX + dir * physics.SHOT_MUZZLE_OFFSET_UNITS;

    const aim = physics.solveAim({ x0, y0, targetX: oppX, targetY, wind });
    if (!aim) {
        return { action: 'skip', reason: 'tanks: aim solver found no candidate' };
    }

    const factor = rb.handicapFactor(rbState);
    const noise = factorToNoise((factor as number));
    const rotDeg = aim.rotDeg + gauss(noise.rotSigma, ctx && (ctx as ExtraContextRead).rng);
    const power01 = Math.min(1, Math.max(0.05, aim.power01 + gauss(noise.powerSigma, ctx && (ctx as ExtraContextRead).rng)));

    // Write MY tank's rotation + power back into the board, append shoot:<player>.
    const newBoard = { ...b, ['tank' + player + 'rot']: Number(rotDeg.toFixed(2)), ['tank' + player + 'power']: Number(power01.toFixed(4)) };
    const boardStr = Object.keys(newBoard).map((k) => k + ',' + newBoard[k]).join('&');
    const newReplay = 'board:' + boardStr + '|shoot:' + player;

    const updates: PlayStateRead = {
        sender: (ctx as ExtraContextRead).botUuid,
        ['player' + player]: (ctx as ExtraContextRead).botUuid,
        ['avatar' + player]: (ctx as ExtraContextRead).botAvatar,
        replay: newReplay,
    };

    const newState: PlayStateRead = { ...(state as PlayStateRead), ...updates };
    if (newState.player2 !== (ctx as ExtraContextRead).botUuid && !newState.player1) newState.player1 = (ctx as ExtraContextRead).botUuid;

    const wasInvite =
        ('start' in (state as PlayStateRead)) || ('game_name' in (state as PlayStateRead)) || String((state as PlayStateRead).version) === '5';
    if (wasInvite) {
        delete newState.start;
        delete newState.caption;
        delete newState.game_name;
        delete newState.player;
        newState.version = '0';
        newState.num = '2';
    } else {
        // Subsequent turn (not the invite): advance num so each card in the
        // session carries a fresh incrementing number, matching real GamePigeon,
        // and stamp player = the slot that just moved (Bot's), so the card is not
        // mislabelled with the opponent's stale slot inherited from the inbound card.
        newState.num = (state as PlayStateRead).num ? String(Number((state as PlayStateRead).num) + 1) : '2';
        newState.player = String(player);
    }

    const replaySummary =
        'tanks reply: slot=' + player + ' vs opp=' + opponent +
        ' myX=' + myX + ' oppX=' + oppX + ' wind=' + wind +
        ' solvedRot=' + aim.rotDeg.toFixed(2) + ' solvedPow=' + aim.power01.toFixed(3) +
        ' predMiss=' + aim.minDist.toFixed(1) + (aim.hit ? ' (HIT in sim)' : ' (miss in sim)') +
        ' sentRot=' + rotDeg.toFixed(2) + ' sentPow=' + power01.toFixed(3) +
        ' noise=' + noise.label +
        ' replay=' + newReplay +
        ' version=' + newState.version;
    const action = ENABLE_SEND ? 'play' : 'skip';
    return {
        action,
        reason: ENABLE_SEND ? undefined : 'GP_TANKS_SEND!=1 (physics UNVERIFIED vs real capture - see CAPTURE CHECKLIST) | ' + replaySummary,
        newState,
        botScore: Number(power01.toFixed(3)),
        botWords: Number(rotDeg.toFixed(1)),
        mode: noise.label,
        targetN: null,
        fullScore: aim.minDist,
        fullWords: aim.hit ? 1 : 0,
        finishes: false,
        botWon: null,
        player,
        opponent,
    };
}

export const tanksPlay = {
    game: GAME_ID,
    displayName: DISPLAY_NAME,
    enableSend: ENABLE_SEND,
    solve,
    decideMove,
    getSubtitle,
    looksLikeTanks,
    parseReplay,
    parseBoardKV,
    factorToNoise,
};

