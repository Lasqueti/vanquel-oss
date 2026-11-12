// tests/games-watcher.test.ts
// The games watcher's turn logic against a fake tweak client: it seeds past
// history, plays a card once, never sends a move twice, retries and then
// dead-letters a failing card, declines unknown games once per opponent, and
// closes a finished game with one "gg".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatcher, GP_BID } from '../games/watcher.ts';
import type { Decoded, WatcherOptions } from '../games/watcher.ts';
import type { GameRow, TweakClient } from '../bridges/phone/tweak.ts';
import { parseDictionary } from '../games/wordhunt-engine.ts';

const OPPONENT = '+15550100002';
const OTHER = '+15550100003';
const BOT_UUID = 'BOT-UUID-0001';

function card(rowId: number, state: Record<string, unknown>, from = OPPONENT): GameRow {
    return {
        rowId,
        guid: `GUID-${rowId}`,
        chat: `iMessage;-;${from}`,
        isFromMe: false,
        payloadBase64: Buffer.from(JSON.stringify(state)).toString('base64'),
        balloonBundleId: GP_BID,
    };
}

// The opponent played Word Hunt first and scored 400 with "CATS".
const huntCard = (rowId: number, from = OPPONENT) => card(rowId, {
    game: 'hunt', id: `S-${from.slice(-4)}`, letters: 'CATSXXXXXXXXXXXX', version: '0',
    player2: 'OPP-UUID', score2: '400', words2: '1', words_list2: 'CATS',
}, from);

function fakeTweak(rows: GameRow[], opts: { status?: string; guid?: string | null; failSend?: boolean } = {}) {
    const sent: Array<Record<string, string>> = [];
    const tweak = {
        async readGames(after: number, limit: number) {
            return rows.filter((r) => r.rowId > after).sort((a, b) => a.rowId - b.rowId).slice(0, limit);
        },
        async sendBalloon(fields: Record<string, string>) {
            if (opts.failSend) throw new Error('phone not answering');
            sent.push(fields);
            const guid = opts.guid === undefined ? `OUT-${sent.length}` : opts.guid;
            return { guid, raw: guid ? `OK guid=${guid}` : 'OK' };
        },
        async messageStatus() {
            return opts.status ?? 'OK found=1 rowid=9 sent=1 delivered=1 error=0';
        },
    } as unknown as TweakClient;
    return { tweak, sent, rows };
}

function setup(rows: GameRow[], tweakOpts: Parameters<typeof fakeTweak>[1] = {}, extra: Partial<WatcherOptions> = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'games-watch-'));
    const fake = fakeTweak(rows, tweakOpts);
    const texts: Array<{ to: string; text: string }> = [];
    const alerts: string[] = [];
    const logs: string[] = [];
    const watcher = createWatcher({
        lines: [{ id: 'phone1', tweak: fake.tweak }],
        dataDir,
        dict: parseDictionary('cat\ncats\ntac\ndog'),
        identity: { uuid: BOT_UUID, avatar: 'body,1' },
        log: (m) => logs.push(m),
        alert: async (t) => { alerts.push(t); },
        decodeCard: (payload): Decoded => ({ state: JSON.parse(payload.toString()), templateBin: join(dataDir, 'missing.bin') }),
        archiveReply: (_t, url) => Buffer.from(url),
        sendText: async (_line, to, text) => { texts.push({ to, text }); },
        deliveryChecks: 3,
        deliveryCheckMs: 0,
        pollLimit: 2,
        ...extra,
    });
    const poller = watcher.makeLinePoller({ id: 'phone1', tweak: fake.tweak });
    const cleanup = () => rmSync(dataDir, { recursive: true, force: true });
    return { watcher, poller, fake, texts, alerts, logs, dataDir, cleanup };
}

test('the first poll seeds the cursor past every existing card, across pages, and sends nothing', async () => {
    const t = setup([huntCard(10), huntCard(11), huntCard(12), huntCard(13), huntCard(14)]);
    try {
        await t.poller.poll();
        assert.equal(t.poller.getCursor(), 14);
        assert.equal(t.fake.sent.length, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(t.dataDir, 'line-phone1.json'), 'utf8')), { lastSeenRowId: 14 });
    } finally { t.cleanup(); }
});

test('a Word Hunt card is answered once, threaded on its first card, and closed with one gg', async () => {
    const t = setup([]);
    try {
        await t.poller.poll(); // seed at 0
        t.fake.rows.push(huntCard(20));
        await t.poller.poll();
        assert.equal(t.fake.sent.length, 1);
        const fields = t.fake.sent[0];
        assert.equal(fields.to, OPPONENT);
        assert.equal(fields.bundleId, GP_BID);
        assert.equal(fields.replyToGuid, 'GUID-20');
        const url = Buffer.from(fields.payloadBase64, 'base64').toString();
        assert.match(url, /^data:\?ver=52&data=/);
        assert.equal(t.poller.getCursor(), 20);

        await t.watcher.drainFinishOutbox();
        assert.deepEqual(t.texts, [{ to: OPPONENT, text: 'gg' }]);

        // Polling again finds nothing new; the same card is never played twice.
        await t.poller.poll();
        assert.equal(t.fake.sent.length, 1);

        // The opponent's device echoes the finished game: no move, no second gg.
        const { cipher } = await import('../games/cipher.ts');
        const finished = cipher.parseEnvelope(url) as Record<string, unknown>;
        t.fake.rows.push(card(21, finished));
        await t.poller.poll();
        await t.watcher.drainFinishOutbox();
        assert.equal(t.fake.sent.length, 1);
        assert.equal(t.texts.length, 1);
        assert.equal(t.watcher.loadRbAll()[`iMessage;-;${OPPONENT}`].gamesPlayed, 1);
    } finally { t.cleanup(); }
});

test('a duplicate delivery of the same opponent move is ignored', async () => {
    const t = setup([]);
    try {
        await t.poller.poll();
        t.fake.rows.push(huntCard(30));
        await t.poller.poll();
        t.fake.rows.push({ ...huntCard(31), guid: 'GUID-31-dup' });
        await t.poller.poll();
        assert.equal(t.fake.sent.length, 1);
        assert.equal(t.poller.getCursor(), 31);
    } finally { t.cleanup(); }
});

test('a move already accepted by the phone is not sent again on retry', async () => {
    const t = setup([]);
    try {
        await t.poller.poll();
        // An earlier attempt got the balloon out, then died before committing.
        writeFileSync(join(t.dataDir, 'failures.json'), JSON.stringify({ 'phone1:40': { starts: 1, acceptedAt: Date.now() } }));
        t.fake.rows.push(huntCard(40));
        await t.poller.poll();
        assert.equal(t.fake.sent.length, 0);
        assert.equal(t.poller.getCursor(), 40);
        assert.deepEqual(t.watcher.readFailureAll(), {});
    } finally { t.cleanup(); }
});

test('a failing send holds the cursor, retries, then dead-letters with an alert', async () => {
    const t = setup([], { failSend: true }, { maxAttempts: 3 });
    try {
        await t.poller.poll();
        t.fake.rows.push(huntCard(50), huntCard(51, OTHER));
        await t.poller.poll();
        assert.equal(t.poller.getCursor(), 0, 'held for retry');
        await t.poller.poll();
        assert.equal(t.poller.getCursor(), 0);
        await t.poller.poll();
        // third failure dead-letters 50 and moves on; 51 then fails its first try
        assert.equal(t.poller.getCursor(), 50);
        assert.equal(t.alerts.length, 1);
        assert.match(t.alerts[0], /dead-lettered[\s\S]*row: 50/);
    } finally { t.cleanup(); }
});

test('a balloon the phone never delivers is a failure, not a success', async () => {
    const t = setup([], { status: 'OK found=1 sent=1 delivered=0 error=0' });
    try {
        await t.poller.poll();
        t.fake.rows.push(huntCard(60));
        await t.poller.poll();
        assert.equal(t.fake.sent.length, 1);
        assert.equal(t.poller.getCursor(), 0, 'cursor held: not delivered');
        assert.equal(t.watcher.readFailureAll()['phone1:60'].attempts, 1);
    } finally { t.cleanup(); }
});

test('an unknown game gets one decline per opponent per cooldown', async () => {
    const t = setup([]);
    try {
        await t.poller.poll();
        t.fake.rows.push(card(70, { game: 'chess', id: 'C1' }), card(71, { game: 'checkers', id: 'C2' }), card(72, { game: 'chess', id: 'C3' }, OTHER));
        await t.poller.poll();
        await t.poller.poll();
        await new Promise((r) => setImmediate(r));
        assert.equal(t.fake.sent.length, 0);
        assert.equal(t.texts.length, 2);
        assert.deepEqual(t.texts.map((x) => x.to), [OPPONENT, OTHER]);
        assert.match(t.texts[0].text, /Chess/);
        assert.equal(t.poller.getCursor(), 72);
    } finally { t.cleanup(); }
});

test('a forged game name such as "constructor" is treated as unknown, not crashed on', async () => {
    const t = setup([]);
    try {
        await t.poller.poll();
        t.fake.rows.push(card(80, { game: 'constructor', id: 'X' }));
        await t.poller.poll();
        await new Promise((r) => setImmediate(r));
        assert.equal(t.poller.getCursor(), 80);
        assert.match(t.texts[0].text, /that one/);
    } finally { t.cleanup(); }
});

test('nothing is sent to a contact who opted out', async () => {
    const t = setup([], {}, { isOptedOut: (h) => h === OPPONENT });
    try {
        await t.poller.poll();
        t.fake.rows.push(huntCard(90), card(91, { game: 'chess', id: 'C9' }));
        await t.poller.poll();
        await new Promise((r) => setImmediate(r));
        assert.equal(t.fake.sent.length, 0);
        assert.equal(t.texts.length, 0);
        assert.equal(t.poller.getCursor(), 91);
    } finally { t.cleanup(); }
});

test('dry run logs the move instead of sending it', async () => {
    const t = setup([], {}, { dryRun: true });
    try {
        await t.poller.poll();
        t.fake.rows.push(huntCard(100));
        await t.poller.poll();
        assert.equal(t.fake.sent.length, 0);
        assert.ok(t.logs.some((l) => l.startsWith('WOULD SEND')));
    } finally { t.cleanup(); }
});

test('a tweak that accepts without a message guid is retried', async () => {
    const t = setup([], { guid: null });
    try {
        await t.poller.poll();
        t.fake.rows.push(huntCard(110));
        await t.poller.poll();
        assert.equal(t.poller.getCursor(), 0);
        assert.match(String(t.watcher.readFailureAll()['phone1:110'].lastError), /without a message guid/);
    } finally { t.cleanup(); }
});

test('the registry covers the live catalog and every module has the play interface', async () => {
    const { defaultGames } = await import('../games/watcher.ts');
    const { catalog } = await import('../games/catalog.ts');
    const games = defaultGames();
    assert.deepEqual(Object.keys(games).sort(), ['anagrams', 'archery', 'basketball', 'beer', 'darts', 'dots', 'fill', 'golf', 'hunt', 'pool', 'tanks', 'wordbites']);
    assert.equal(Object.getPrototypeOf(games), null);
    for (const [id, mod] of Object.entries(games)) {
        assert.equal(typeof mod.solve, 'function', id);
        assert.equal(typeof mod.decideMove, 'function', id);
        assert.ok(mod.displayName, id);
    }
    const names = new Set(Object.values(games).map((m) => m.displayName));
    // The catalog says "Dots"; the module's display name is "Dots & Boxes".
    for (const name of catalog.LIVE_GAME_NAMES) assert.ok([...names].some((n) => n === name || n.startsWith(name + ' ')), name);
});
