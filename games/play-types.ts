// games/play-types.ts
import type { AdaptiveRead } from './strength-types.ts';

// Wire cards, context and supplied solve results remain unknown at entry.
// These erased views describe original reads; they do not validate game data.
export interface PlayStateRead { [key: string]: unknown }
export interface PlayContextRead { botUuid?: unknown; botAvatar?: unknown; rbState?: unknown }
export interface GameDecision {
    action: 'ignore' | 'result' | 'skip' | 'play'; reason?: string;
    newState?: PlayStateRead; winner?: string; flag?: string; botWon?: boolean | null;
    botScore?: unknown; oppScore?: unknown; botWords?: unknown;
    fullScore?: unknown; fullWords?: unknown; mode?: string; targetN?: null;
    finishes?: boolean; player?: number; opponent?: number;
}
export interface PlayAdaptiveRead extends AdaptiveRead {
    difficulty: PropertyKey; gamesPlayed: number;
    scoreStats?: Record<PropertyKey, {n: number; avg: number}>;
}
export interface ArcherySolveRead { seed: unknown; setNum: number; p1: number; p2: number; p1sets: number; p2sets: number; pre: number[] | null; post: number[] | null }
export interface DartsSolveRead { startScore: number; p1: number; p2: number }
export interface DotsSolveRead { size: number; drawnEdges: number; board: import('./target-engine-types.ts').DotsBoard }
