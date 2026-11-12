// src/agent/contact-card.ts
// SEND_CONTACT_CARD=1: after the agent's first reply to a new person over
// iMessage, it sends its contact card (.vcf), so the person can save the
// number with a name in one tap. Once per person, never to a group. The card
// is AGENT_NAME at BUSINESS_NAME with CONTACT_PHONE.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ContactCard {
    name: string;
    org: string;
    phone: string;
}

function escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

export function buildVCard(card: ContactCard): string {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:;${escape(card.name)};;;`, `FN:${escape(card.name)}`];
    if (card.org) lines.push(`ORG:${escape(card.org)}`);
    lines.push(`TEL;TYPE=CELL:${escape(card.phone)}`, 'END:VCARD');
    return `${lines.join('\r\n')}\r\n`;
}

// Writes the card into dir and returns its absolute path.
export function writeContactCard(dir: string, card: ContactCard): string {
    const path = join(resolve(dir), 'contact.vcf');
    mkdirSync(resolve(dir), { recursive: true });
    writeFileSync(path, buildVCard(card));
    return path;
}
