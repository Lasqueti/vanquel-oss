// src/agent/voice-note.ts
// Optional spoken replies over iMessage. When the person asks for a voice
// message, the model calls reply_with_voice_note and its next answer is
// spoken instead of typed:
//   text -> POST {TTS_BASE_URL}/audio/speech (any OpenAI-compatible speech
//   API) -> MP3 -> afconvert (built into macOS) -> m4a -> bridge /send with
//   audio: true, which iMessage shows as a native voice message.
// Any failure falls back to the same words as text, so a voice note can never
// cost the person their reply.
//
// From production: speech takes plain text, so links, markdown and emoji are
// dropped rather than read aloud; and a reply that is long, or a list, or full
// of numbers, is better read than heard, so it stays text.

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MAX_VOICE_CHARS = 600;
// Files stay a day so the bridge has long finished with them, then go.
const KEEP_MS = 24 * 3600 * 1000;

export function speakable(text: string): string {
    return text
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, 'the link')
        .replace(/^[ \t]*(?:#{1,6}|>)[ \t]+/gm, '')
        .replace(/[*_`~]/g, '')
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isVoiceable(text: string): boolean {
    if (/https?:\/\/|\bwww\.\S+/i.test(text)) return false;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.some((l) => /^(?:[-*]|\d+[.)])\s/.test(l))) return false;
    if ((text.match(/\d/g) ?? []).length >= 10) return false;
    const spoken = speakable(text);
    return spoken.length > 0 && spoken.length <= MAX_VOICE_CHARS;
}

export interface VoiceNoteConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    // Where the m4a files are written (MEDIA_DIR).
    outDir: string;
    fetchImpl?: typeof fetch;
    toM4a?: (mp3Path: string, m4aPath: string) => Promise<void>;
}

export interface VoiceNotes {
    // The absolute path of an m4a file. Throws on any failure.
    synthesize(text: string): Promise<string>;
}

async function afconvert(mp3Path: string, m4aPath: string): Promise<void> {
    await execFileAsync('afconvert', ['-f', 'm4af', '-d', 'aac', '-c', '1', mp3Path, m4aPath], { timeout: 15_000 });
}

async function pruneOld(dir: string, now: number): Promise<void> {
    for (const name of await readdir(dir)) {
        if (!name.startsWith('voice-')) continue;
        const path = join(dir, name);
        if (now - (await stat(path)).mtimeMs > KEEP_MS) await rm(path, { force: true });
    }
}

export function createVoiceNotes(config: VoiceNoteConfig): VoiceNotes {
    const fetchImpl = config.fetchImpl ?? fetch;
    const toM4a = config.toM4a ?? afconvert;
    const outDir = resolve(config.outDir);
    return {
        async synthesize(text) {
            const input = speakable(text);
            if (!input || input.length > MAX_VOICE_CHARS) throw new Error('reply is not speakable');
            const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify({ model: config.model, voice: config.voice, input, response_format: 'mp3' }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error(`speech API answered ${response.status}`);
            await mkdir(outDir, { recursive: true });
            await pruneOld(outDir, Date.now()).catch(() => {});
            const stem = join(outDir, `voice-${randomUUID()}`);
            await writeFile(`${stem}.mp3`, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
            try {
                await toM4a(`${stem}.mp3`, `${stem}.m4a`);
            } finally {
                await rm(`${stem}.mp3`, { force: true });
            }
            return `${stem}.m4a`;
        },
    };
}
