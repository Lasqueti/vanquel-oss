// games/word-play-types.ts
import type { AdaptiveRead } from './strength-types.ts';
import type { PlayStateRead } from './play-types.ts';

// Decoded cards, dictionary handles and precomputed solves stay unknown at entry.
// Erased views below describe original reads without adding validation or defaults.
export interface WordContextRead { botUuid?: unknown; botAvatar?: unknown; rbState?: unknown }
export interface WordDepsRead { dict?: unknown }
export interface WordSolveRead { sortedWords?: unknown; wordCount?: unknown; score?: unknown; ok?: unknown }
export interface WordAdaptiveRead extends AdaptiveRead { lastPlayedBoard?: unknown }
export interface WordFactoryOptions { enableSend?: unknown }
export interface WordDecision {
    action: 'ignore' | 'result' | 'skip' | 'play'; reason?: string; newState?: PlayStateRead;
    winner?: string; flag?: string; botWon?: boolean | null;
    botScore?: unknown; oppScore?: unknown; botWords?: unknown;
    fullScore?: unknown; fullWords?: unknown; mode?: unknown; targetN?: unknown;
    boardId?: unknown; player?: number; opponent?: number;
}
export interface WordListRead { length: unknown; join(separator: string): unknown }
