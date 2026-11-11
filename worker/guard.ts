// worker/guard.ts
// The browser worker's safety rules, kept pure so they are easy to test.
//   urlAllowed       only public http(s): no localhost, private ranges,
//                    link-local or cloud metadata addresses (SSRF)
//   isMoneyControl   a button or link that spends money: the worker stops and
//                    hands back instead of clicking it
//   fencePage        page text is DATA, never instructions: wrapped in a
//                    random fence the model is told not to obey
//
// Known limit: urlAllowed checks the hostname as written. A public name that
// resolves to a private address (DNS rebinding) is only caught by Chrome's
// --host-resolver-rules for the names listed there. Run the worker on a
// machine whose network has nothing you would not expose to the internet.

import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const BLOCKED_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

export function isPrivateAddress(host: string): boolean {
    const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
    const kind = isIP(bare);
    if (kind === 4) {
        const [a, b] = bare.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
    }
    if (kind === 6) {
        return bare === '::' || bare === '::1' || bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe80') || bare.startsWith('::ffff:');
    }
    return false;
}

export function urlAllowed(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password) return false;
    return !BLOCKED_NAMES.test(url.hostname) && !isPrivateAddress(url.hostname);
}

const MONEY = /\b(buy|purchase|place (your )?order|pay|checkout|check out|complete (order|purchase)|subscribe|donate|confirm (order|payment|purchase)|add payment|book now and pay)\b/i;

export function isMoneyControl(label: string): boolean {
    return MONEY.test(label);
}

// Zero-width and bidi control characters can hide instructions in page text.
export function stripInvisible(text: string): string {
    return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
}

export function fencePage(text: string): { fenced: string; fenceId: string } {
    const fenceId = randomBytes(6).toString('hex');
    const clean = stripInvisible(text).replaceAll(`PAGE-${fenceId}`, '');
    return { fenced: `<<<PAGE-${fenceId}\n${clean}\nPAGE-${fenceId}>>>`, fenceId };
}

// Chrome flag that makes these names fail to resolve at all.
export const HOST_RESOLVER_RULES = '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP *.localhost ~NOTFOUND, MAP *.local ~NOTFOUND, MAP *.internal ~NOTFOUND, MAP metadata.google.internal ~NOTFOUND';
