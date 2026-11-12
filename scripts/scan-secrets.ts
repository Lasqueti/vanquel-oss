// scripts/scan-secrets.ts
// Fails if the repo contains anything that looks like a secret or personal
// data: API keys and tokens, private keys, real-looking phone numbers, email
// addresses outside example domains, and private or tailnet IP addresses.
// Run it before every commit and every publish: npm run scan
//
// Allowed on purpose: the fictional 555-01xx phone range, example.com/org/net
// addresses, and a short list of well-known private IPs used in docs and tests.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Finding {
    file: string;
    line: number;
    rule: string;
    excerpt: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXT = /\.(ts|js|json|md|txt|sh|c|h|m|mm|swift|entitlements|control|cfg|env|example|yml|yaml|plist|html|css)$|^\.[a-z]+$|^[A-Z]+$/i;

const ALLOWED_IPS = new Set(['127.0.0.1', '0.0.0.0', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.20.0.1', '172.32.0.1', '100.64.0.0']);
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net)|yourdomain\.(com|example))$/i;
const FICTIONAL_PHONE = /^\+?1?[-. (]*555[-. )]*01\d{2}/;

const RULES: Array<{ rule: string; pattern: RegExp; allow?: (match: string) => boolean }> = [
    { rule: 'openai-style key', pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g },
    { rule: 'stripe key', pattern: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g },
    { rule: 'slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { rule: 'slack webhook', pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g },
    { rule: 'github token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
    { rule: 'aws key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { rule: 'google key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { rule: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { rule: 'twilio sid', pattern: /\bAC[0-9a-f]{32}\b/g },
    { rule: 'discord webhook', pattern: /discord(app)?\.com\/api\/webhooks\/\d+/g },
    { rule: 'phone number', pattern: /\+\d{10,15}\b|\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, allow: (m) => FICTIONAL_PHONE.test(m) },
    { rule: 'email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, allow: (m) => ALLOWED_EMAIL_DOMAINS.test(m) },
    { rule: 'private or tailnet IP', pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g, allow: (m) => ALLOWED_IPS.has(m) },
    { rule: 'em dash', pattern: /\u2014/g },
];

function walk(dir: string, root: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (!SKIP_DIRS.has(name)) walk(path, root, out);
        } else if (!SKIP_FILES.has(name) && TEXT_EXT.test(name)) {
            out.push(path);
        }
    }
}

export function scanText(file: string, text: string): Finding[] {
    const findings: Finding[] = [];
    text.split('\n').forEach((content, index) => {
        if (content.includes('scan-allow')) return;
        for (const { rule, pattern, allow } of RULES) {
            for (const match of content.matchAll(pattern)) {
                if (allow?.(match[0])) continue;
                findings.push({ file, line: index + 1, rule, excerpt: match[0].slice(0, 12) + (match[0].length > 12 ? '...' : '') });
            }
        }
    });
    return findings;
}

export function scanRepo(root: string): Finding[] {
    const files: string[] = [];
    walk(root, root, files);
    return files.flatMap((path) => scanText(relative(root, path), readFileSync(path, 'utf8')));
}

if (process.argv[1]?.endsWith('scan-secrets.ts')) {
    const findings = scanRepo(process.cwd());
    for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.excerpt}`);
    console.log(findings.length ? `\n${findings.length} finding(s). Fix them before committing.` : 'scan clean');
    process.exitCode = findings.length ? 1 : 0;
}
