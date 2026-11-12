// games/strength-types.ts
// Raw adaptive state and caller-supplied dictionaries remain unknown at entry.
// The read views describe only original operations; they add no validation.
export type GameRandom = () => number;
export type GameHash = (...values: unknown[]) => number;
export type WordScore = (word: unknown) => number;
export interface WordPiece { orient: number; row: number; col: number; letters: string }
export interface WordRead { length: number; [index: number]: string; toUpperCase(): unknown }
export interface WordCollection { forEach(callback: (word: WordRead) => void): void }
export interface DictionaryRead extends WordCollection { words?: WordCollection }
export interface SkillOptions { minFactor?: number; maxFactor?: number; at0?: number; at1?: number; floorClamp?: number }
export interface CatchupOptions { maxEase?: number; maxPush?: number }
export interface AdaptiveRead {
    difficulty?: PropertyKey; gamesPlayed?: number; lastBotResult?: unknown;
    adaptiveFactors?: Record<PropertyKey, number>; adaptiveFactor?: number; seedFactor?: number;
    gamesPlayedByGame?: Record<PropertyKey, unknown>; userAvgScore?: number;
    scoreStats?: Record<PropertyKey, { n?: number; avg?: number | null; best?: number | null }>;
    recentResults?: unknown[]; recentResultsByGame?: Record<PropertyKey, unknown[]>;
}
export interface ReferenceRead { gameId?: PropertyKey; oppScoreVisible?: number; defaultUserScore?: unknown; boardFindable?: number; humanFraction?: number }
export interface SubmissionRead extends ReferenceRead { rbState?: AdaptiveRead; sortedWords?: unknown[]; scoreForWord: WordScore }
export interface AdaptiveUpdateRead { botWon?: unknown; oppScore?: number; gameId?: PropertyKey; adjustFactor?: unknown }
export interface AdaptiveUpdateResult { adaptiveFactor: number; adaptiveFactors: Record<PropertyKey, unknown>; gamesPlayedByGame: Record<PropertyKey, unknown>; userAvgScore: unknown; recentResults: unknown[]; recentResultsByGame: Record<PropertyKey, unknown[]>; scoreStats: Record<PropertyKey, unknown>; seedFactor?: unknown }
