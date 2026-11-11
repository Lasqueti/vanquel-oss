import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo, scanText } from '../scripts/scan-secrets.ts';

test('the scanner catches what it should and allows the fictional ranges', () => {
    // Built from pieces so this file does not trip the scanner itself.
    const fake = ['+4420', '7946', '0000'].join('');
    const rules = (text: string) => scanText('x', text).map((f) => f.rule);
    assert.deepEqual(rules(`call ${fake}`), ['phone number']);
    assert.deepEqual(rules('call +15550100123'), []);
    assert.deepEqual(rules(['me', 'realmail.com'].join('@')), ['email address']);
    assert.deepEqual(rules('help@example.com'), []);
    assert.deepEqual(rules(`ssh ${['192', '168', '7', '42'].join('.')}`), ['private or tailnet IP']);
    assert.deepEqual(rules(`key ${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')}`), ['openai-style key']);
});

test('the repository itself scans clean', () => {
    assert.deepEqual(scanRepo(process.cwd()), []);
});
