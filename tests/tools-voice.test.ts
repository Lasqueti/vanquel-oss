import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { buildTools } from '../src/agent/tools.ts';
import type { ToolContext } from '../src/agent/tools.ts';
import { createVoiceNotes, isVoiceable, speakable } from '../src/agent/voice-note.ts';
import { buildVCard, writeContactCard } from '../src/agent/contact-card.ts';
import { PERSON } from './helpers.ts';

function context(channel: ToolContext['address']['channel'], turn?: ToolContext['turn']): ToolContext {
    return { address: { channel, handle: PERSON }, store: openStore(':memory:'), now: () => new Date(), operator: { notifyHandoff: async () => {}, forward: async () => {} }, lastUserText: '', turn };
}

test('reply_with_voice_note is offered only with TTS, and only works over iMessage', async () => {
    assert.ok(!buildTools({ browse: false }).some((t) => t.schema.function.name === 'reply_with_voice_note'));
    const tool = buildTools({ browse: false, voice: true }).find((t) => t.schema.function.name === 'reply_with_voice_note')!;
    const turn = { voiceNote: false };
    assert.match(await tool.run({}, context('email', turn)), /only work over iMessage/);
    assert.equal(turn.voiceNote, false);
    assert.match(await tool.run({}, context('imessage', turn)), /voice message/);
    assert.equal(turn.voiceNote, true);
});

test('speech text drops links, markdown and emoji; lists and long replies stay text', () => {
    assert.equal(speakable('**Sure** see [the menu](https://example.com/m) \u{1F389}'), 'Sure see the menu');
    assert.ok(isVoiceable('Sure, see you Friday at noon.'));
    assert.ok(!isVoiceable('Book here: https://example.com'));
    assert.ok(!isVoiceable('Options:\n- Monday\n- Tuesday'));
    assert.ok(!isVoiceable('x'.repeat(601)));
});

test('a voice note is synthesized as m4a in the media folder, and old ones are pruned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-'));
    try {
        const old = join(dir, 'voice-old.m4a');
        writeFileSync(old, 'x');
        utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
        let request: Record<string, unknown> = {};
        let url = '';
        const notes = createVoiceNotes({
            baseUrl: 'https://tts.example.com/v1/', apiKey: 'key', model: 'tts-model', voice: 'alloy', outDir: dir,
            fetchImpl: (async (u: string, init: RequestInit) => {
                url = u;
                request = JSON.parse(String(init.body)) as Record<string, unknown>;
                return new Response(new Uint8Array([1, 2, 3]));
            }) as typeof fetch,
            toM4a: async (mp3, m4a) => writeFileSync(m4a, readFileSync(mp3)),
        });
        const path = await notes.synthesize('See you **Friday**.');
        assert.equal(url, 'https://tts.example.com/v1/audio/speech');
        assert.deepEqual(request, { model: 'tts-model', voice: 'alloy', input: 'See you Friday.', response_format: 'mp3' });
        assert.ok(path.startsWith(dir) && path.endsWith('.m4a'));
        assert.deepEqual([...readFileSync(path)], [1, 2, 3]);
        assert.ok(!existsSync(path.replace(/\.m4a$/, '.mp3')));
        assert.ok(!existsSync(old));
        await assert.rejects(notes.synthesize('\u{1F389}'), /not speakable/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the contact card is a valid, escaped vCard', () => {
    const card = buildVCard({ name: 'Sam', org: 'Smith, Jones; Co', phone: '+15550100100' });
    assert.equal(card, 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Sam;;;\r\nFN:Sam\r\nORG:Smith\\, Jones\\; Co\r\nTEL;TYPE=CELL:+15550100100\r\nEND:VCARD\r\n');
    const dir = mkdtempSync(join(tmpdir(), 'card-'));
    try {
        const path = writeContactCard(dir, { name: 'Sam', org: '', phone: '+15550100100' });
        assert.ok(path.endsWith('contact.vcf'));
        assert.doesNotMatch(readFileSync(path, 'utf8'), /ORG:/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
