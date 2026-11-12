// games/play-extra-types.ts
import type { PlayStateRead } from './play-types.ts';
import type { GolfStroke } from './engine-types.ts';

// These are erased read views at original operations. Wire cards, supplied
// contexts, boards and planner results are not newly validated or normalized.
export interface ExtraContextRead { botUuid?: unknown; botAvatar?: unknown; rbState?: unknown; rng?: unknown }
export interface ExtraDecision {
    action: 'ignore' | 'result' | 'skip' | 'play'; reason?: string; newState?: PlayStateRead;
    winner?: unknown; flag?: unknown; botWon?: boolean | null;
    botScore?: unknown; oppScore?: unknown; botWords?: unknown;
    fullScore?: unknown; fullWords?: unknown; targetN?: unknown; mode?: string;
    eventScore?: unknown; boardId?: string; note?: string;
    finishes?: boolean; player?: number; opponent?: number;
}
export interface BeerSolveRead { seed: number; startBoard: {rack1: number[]; rack2: number[]} }
export interface FillReplayRead { pre: number[]; post: number[]; move: number; moverCorner: number }
export interface FillSolveRead { board: number[]; replayInfo: FillReplayRead | null; c1: number; c2: number; terminal: unknown }
export interface GolfSolveRead { mode: string; holeCount: number; seed: number }
export interface GolfPlanRead { sunk: unknown; strokes: GolfStroke[] }
export interface EaseAuditRow { hole: unknown; dist: number; rotation: number; angErr: number; frac: number; advance: number }
export interface TanksSolveRead { board: Record<string, number>; lastShoot: unknown; freshInvite: unknown }
