// src/agent/media.ts
// Attachments people send, as the model sees them.
//
//   Every attachment becomes a short note in the text ("[photo]", "[file:
//   menu.pdf]"), so the model knows something came even when it cannot look.
//   With LLM_VISION=1, photos in the messages it has not answered yet are
//   also fetched from the bridge and sent as image parts (data URLs), so a
//   model that can see gets the picture itself.
//
// Rules from production: only fetch from a bridge of this machine (the URL's
// origin must be one of IMESSAGE_LINES), never from wherever a payload
// points; cap the size; and turn iPhone HEIC photos into JPEG with macOS's
// built-in `sips`, because OpenAI-style APIs reject HEIC. Off a Mac, a HEIC
// photo stays a "[photo]" note.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Attachment } from '../channels/types.ts';

const execFileAsync = promisify(execFile);

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const HEIC = /^image\/hei[cf]/;

export type ImageLoader = (attachment: Attachment) => Promise<string | null>;

export function isImage(attachment: Attachment): boolean {
    return attachment.mimeType.startsWith('image/') || /\.(jpe?g|png|gif|webp|hei[cf])$/i.test(attachment.fileName);
}

export function describeAttachment(attachment: Attachment): string {
    const { mimeType, fileName } = attachment;
    if (isImage(attachment)) return '[photo]';
    if (mimeType.startsWith('audio/') || /\.(caf|m4a|mp3|wav|aac|amr)$/i.test(fileName)) return '[voice message: audio cannot be played here]';
    if (mimeType.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(fileName)) return '[video: cannot be watched here]';
    if (/vcard/.test(mimeType) || /\.vcf$/i.test(fileName)) return '[contact card]';
    return `[file${fileName ? `: ${fileName.slice(0, 80)}` : ''}: cannot be opened here]`;
}

async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-heic-'));
    try {
        await writeFile(join(dir, 'in.heic'), bytes);
        await execFileAsync('sips', ['-s', 'format', 'jpeg', '-Z', '2048', join(dir, 'in.heic'), '--out', join(dir, 'out.jpg')], { timeout: 15_000 });
        return await readFile(join(dir, 'out.jpg'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export interface ImageLoaderConfig {
    // Bridge base URLs (IMESSAGE_LINES values). Only these origins are fetched.
    bridgeUrls: string[];
    bridgeKey: string;
    maxBytes?: number;
    fetchImpl?: typeof fetch;
    convertHeic?: (bytes: Buffer) => Promise<Buffer>;
}

// Returns a data URL, or null when the photo cannot be used. Never throws.
export function createImageLoader(config: ImageLoaderConfig): ImageLoader {
    const fetchImpl = config.fetchImpl ?? fetch;
    const maxBytes = config.maxBytes ?? MAX_IMAGE_BYTES;
    const convertHeic = config.convertHeic ?? (process.platform === 'darwin' ? heicToJpeg : null);
    const origins = new Set(config.bridgeUrls.flatMap((url) => {
        try {
            return [new URL(url).origin];
        } catch {
            return [];
        }
    }));

    return async (attachment) => {
        try {
            if (!isImage(attachment) || !origins.has(new URL(attachment.url).origin)) return null;
            const response = await fetchImpl(attachment.url, { headers: { 'X-Bridge-Key': config.bridgeKey }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!response.ok || Number(response.headers.get('content-length') ?? 0) > maxBytes) return null;
            let bytes: Buffer = Buffer.from(await response.arrayBuffer());
            if (!bytes.length || bytes.length > maxBytes) return null;
            let mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
            if (!mime.startsWith('image/')) mime = attachment.mimeType.startsWith('image/') ? attachment.mimeType : 'image/jpeg';
            if (HEIC.test(mime) || /\.hei[cf]$/i.test(attachment.fileName)) {
                if (!convertHeic) return null;
                bytes = await convertHeic(bytes);
                mime = 'image/jpeg';
            }
            return `data:${mime};base64,${bytes.toString('base64')}`;
        } catch {
            return null;
        }
    };
}
