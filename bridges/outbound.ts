// bridges/outbound.ts
// The request bodies both bridges accept, checked the same way:
//   POST /send     {to, text?, files?: string[], audio?: boolean}
//   POST /typing   {to, active?: boolean}
//   POST /tapback  {to, guid, kind}
// files are absolute paths on this Mac, each an existing file. audio sends
// the one file as a native voice note. A send needs text, files, or both.

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { HttpError } from '../src/http.ts';

export const TAPBACK_KINDS = new Set(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']);

export interface SendRequest {
    to: string;
    text: string;
    files: string[];
    audio: boolean;
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

export function parseSendRequest(body: Record<string, unknown>): SendRequest {
    const to = String(body.to ?? '').trim();
    const text = String(body.text ?? '').trim();
    const audio = body.audio === true;
    if (body.files !== undefined && (!Array.isArray(body.files) || !body.files.every((file) => typeof file === 'string'))) {
        throw new HttpError(400, 'files must be an array of paths');
    }
    const files = ((body.files ?? []) as string[]).map((file) => file.trim()).filter(Boolean);
    if (!to) throw new HttpError(400, 'to is required');
    if (!text && !files.length) throw new HttpError(400, 'text or files is required');
    for (const file of files) {
        if (!isAbsolute(file) || !isFile(file)) throw new HttpError(400, `not a readable absolute file path: ${file}`);
    }
    if (audio && files.length !== 1) throw new HttpError(400, 'audio takes exactly one file');
    return { to, text, files, audio };
}

export function parseTypingRequest(body: Record<string, unknown>): { to: string; active: boolean } {
    const to = String(body.to ?? '').trim();
    if (!to) throw new HttpError(400, 'to is required');
    return { to, active: body.active !== false };
}

export function parseTapbackRequest(body: Record<string, unknown>): { to: string; guid: string; kind: string } {
    const to = String(body.to ?? '').trim();
    const guid = String(body.guid ?? '').trim();
    const kind = String(body.kind ?? '').trim().toLowerCase();
    if (!to || !guid) throw new HttpError(400, 'to and guid are required');
    if (!TAPBACK_KINDS.has(kind)) throw new HttpError(400, `kind must be one of ${[...TAPBACK_KINDS].join(', ')}`);
    return { to, guid, kind };
}
