// Run: node userscripts/lib/redeem.test.js  (activation queue; Steam and the sheet are stubbed)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const sheetRows = [];
const replies = {}; // key -> list of Steam replies, consumed in order ('STALE' = logged-out error page)
const opened = [];
const listeners = {};
let reloads = 0;
const ctx = {
  console, URLSearchParams, Date, setTimeout,
  document: { cookie: 'sessionid=abc123; other=1' },
  location: { reload: () => { reloads++; } },
  GM_getValue: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
  // Value-change listeners fire for every write, as if from another tab (remote).
  GM_setValue: (k, v) => { const old = store[k]; store[k] = v; (listeners[k] || []).forEach((l) => l && l(k, old, v, true)); },
  GM_addValueChangeListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); return k + ':' + (listeners[k].length - 1); },
  GM_removeValueChangeListener: (id) => { const [k, i] = id.split(':'); listeners[k][i] = null; },
  GM_openInTab: (url, opts) => { opened.push(opts); },
  // Sheet writes go through GM_xmlhttpRequest; record the rows and say ok.
  GM_xmlhttpRequest: (o) => {
    const body = JSON.parse(o.data);
    body.rows.forEach((r) => sheetRows.push({ ...r, sheet: body.sheetName || 'Steam Keys' }));
    o.onload({ status: 200, responseText: '{"ok":true}' });
  },
  fetch: async (url, opts) => {
    assert.strictEqual(url, '/account/ajaxregisterkey/');
    const p = new URLSearchParams(opts.body);
    assert.strictEqual(p.get('sessionid'), 'abc123');
    const reply = replies[p.get('product_key')].shift();
    if (reply === 'STALE') return { ok: false, status: 403, json: async () => { throw new Error('html'); } };
    return { ok: true, status: 200, json: async () => reply };
  },
};
vm.createContext(ctx);
const code = ['core.js', 'redeem.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
// No real waiting in tests (later declarations win).
// No real waiting in tests, and Steam's DLC lookup is stubbed (later declarations win).
const dlcOf = { 620590: { name: 'Ancestors Legacy', dlc: [1049810, 799330, 799331, 1100220] }, 100: { name: 'Owned All', dlc: [101] }, 200: { name: 'No DLC', dlc: [] } };
vm.runInContext(code + '\nasync function sleep() {}\nasync function missingDlc(appid, owned) { const d = globalThis.dlcOf[appid]; return d ? { name: d.name, missing: d.dlc.filter((a) => !owned.has(a)), total: d.dlc.length } : null; }\n' +
  ';this.x = { processQueue, enqueueKeys, parseActivation, getQueue, ensureWorker, editionsToActivate, recordLog, editionLike };', Object.assign(ctx, { dlcOf }));
const { processQueue, enqueueKeys, parseActivation, getQueue, ensureWorker, editionsToActivate, recordLog, editionLike } = ctx.x;

const ok = (name) => ({ success: 1, purchase_receipt_info: { line_items: [{ line_item_description: name }] } });
const fail = (detail) => ({ success: 2, purchase_result_details: detail });
assert.deepStrictEqual(JSON.parse(JSON.stringify(parseActivation(ok('Game')))), { code: 1, names: ['Game'] });
assert.strictEqual(parseActivation({ success: 2 }).code, 53); // no detail: treated as rate limit
assert.strictEqual(parseActivation({ success: 2, purchase_receipt_info: { result_detail: 14 } }).code, 14);

Object.assign(replies, {
  A: [ok('Game A')],
  B: [fail(9)],           // already owned: spare
  C: [fail(13)],          // region: spare with note
  D: [fail(24), fail(24)],// needs base: retried once at the end, then reported
  E: [fail(14)],          // invalid
  F: [fail(53), ok('Game F')], // rate limited, then fine after the pause
  G: [ok('Game G')],
});
assert.strictEqual(enqueueKeys('ABCDEFG'.split('').map((k) => ({ title: 'T' + k, key: k })), 'Fanatical'), 7);
assert.strictEqual(enqueueKeys([{ title: 'TA', key: 'A' }]), 0); // no duplicates

const logs = [];
const log = (m) => logs.push(m);
const notActivatedRows = () => sheetRows.filter((r) => r.sheet !== 'Activated');
(async () => {
  // Run 1: stops at F's rate limit.
  await processQueue(log);
  assert.deepStrictEqual(getQueue().map((k) => k.key), ['F', 'G', 'D']);
  assert.strictEqual(getQueue()[0].rateLimited, 1);
  assert.ok(store.rateLimitedUntil > Date.now() + 59 * 60 * 1000);
  assert.deepStrictEqual(notActivatedRows().map((r) => [r.key, r.sheet]), [['B', 'Steam Keys'], ['C', 'Steam Keys'], ['E', 'Not Activated']]);
  assert.strictEqual(notActivatedRows()[0].status, ''); // spare: trade column left blank
  assert.match(notActivatedRows()[1].status, /region/);
  // Activated keys get their own tab, with date and store.
  assert.deepStrictEqual(sheetRows.filter((r) => r.sheet === 'Activated').map((r) => r.key), ['A']);
  assert.match(sheetRows.find((r) => r.key === 'A').status, /^Activated \d\d-\w{3}-\d{4} \(Fanatical\)$/);
  assert.match(logs[logs.length - 1], /rate limit.*3 key\(s\) left/);

  // Run 2 while paused: does nothing.
  await processQueue(log);
  assert.strictEqual(getQueue().length, 3);

  // Run 3 after the pause: F and G activate, D fails for good.
  store.rateLimitedUntil = 0;
  store.activationLock = null;
  await processQueue(log);
  assert.deepStrictEqual(getQueue(), []);
  assert.deepStrictEqual(notActivatedRows().slice(3).map((r) => [r.key, r.sheet]), [['D', 'Not Activated']]);
  assert.deepStrictEqual(sheetRows.filter((r) => r.sheet === 'Activated').map((r) => r.key), ['A', 'F', 'G']);
  assert.ok(logs.some((m) => /OK +TF/.test(m)) && logs.some((m) => /OK +TG/.test(m)));

  // A key that is "rate limited" every time is reported after the retry cap, not retried forever.
  replies.H = [fail(53), fail(53), fail(53), fail(53)];
  enqueueKeys([{ title: 'TH', key: 'H' }]);
  for (let i = 0; i < 4; i++) { store.rateLimitedUntil = 0; await processQueue(log); }
  assert.deepStrictEqual(getQueue(), []);
  assert.deepStrictEqual(notActivatedRows().slice(-1).map((r) => [r.key, r.sheet]), [['H', 'Not Activated']]);

  // Stale session: refresh the tab (up to twice in 10 minutes), keep the key queued.
  replies.S = ['STALE', 'STALE', 'STALE', ok('Game S')];
  enqueueKeys([{ title: 'TS', key: 'S' }]);
  await processQueue(log);
  await processQueue(log);
  assert.strictEqual(reloads, 2);
  await processQueue(log); // third failure: stop and ask to log in, no reload loop
  assert.strictEqual(reloads, 2);
  assert.match(logs[logs.length - 1], /log in to Steam/);
  assert.deepStrictEqual(getQueue().map((k) => k.key), ['S']);
  await processQueue(log); // session works again
  assert.deepStrictEqual(getQueue(), []);
  assert.strictEqual(store.sessionReloads.n, 0); // a working session resets the guard

  // Store pages: no Steam tab answers the ping -> open one in the background, once.
  assert.strictEqual(await ensureWorker(50), ''); // empty queue: nothing to do
  enqueueKeys([{ title: 'TW', key: 'W' }]);
  assert.match(await ensureWorker(50), /background tab/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(opened)), [{ active: false, insert: true }]);
  assert.match(await ensureWorker(50), /is opening/); // a second page right after: no second tab
  assert.strictEqual(opened.length, 1);
  // A live Steam tab answers the ping: no new tab.
  store.activationTabOpening = 0;
  listeners.activationPing = [(k, o, nonce) => ctx.GM_setValue('activationPong', nonce)];
  assert.match(await ensureWorker(50), /Steam tab is activating/);
  assert.strictEqual(opened.length, 1);
  // During a rate-limit pause: no ping, no tab.
  listeners.activationPing = [];
  store.rateLimitedUntil = Date.now() + 60000;
  assert.match(await ensureWorker(50), /rate limit/);
  assert.strictEqual(opened.length, 1);

  // Edition keys for an owned base game: Steam decides only if some DLC is missing.
  assert.ok(editionLike('Ancestors Legacy - Complete Edition') && editionLike('Foo GOTY') && editionLike('Bar + Season Pass'));
  assert.ok(!editionLike('Planescape: Torment: Enhanced Edition') && !editionLike('Mouthwashing'));
  const owned = new Set([620590, 100, 101, 200, 300]);
  const keys = [
    { title: 'Ancestors Legacy - Complete Edition', appid: 620590 }, // owns base, none of 4 DLC -> activate
    { title: 'Owned All - Complete Edition', appid: 100 },           // owns base and its DLC -> spare
    { title: 'No DLC Deluxe Edition', appid: 200 },                  // game has no DLC -> spare
    { title: 'Plain Game', appid: 300 },                             // not edition-like -> spare, no lookup
  ];
  const toActivate = await editionsToActivate(keys, owned, log);
  assert.deepStrictEqual([...toActivate.map((k) => k.appid)], [620590]);
  assert.match(logs.find((m) => /Ancestors Legacy - Complete/.test(m)), /not 4 of its 4 DLC/);
  assert.ok(logs.some((m) => /all 1 of its DLC, so it's a spare/.test(m)));

  // Local log: capped at 1000 lines, entries older than 30 days dropped.
  store.redeemLog = [{ t: 0, m: 'ancient' }];
  for (let i = 0; i < 1005; i++) recordLog('line ' + i);
  assert.strictEqual(store.redeemLog.length, 1000);
  assert.strictEqual(store.redeemLog[0].m, 'line 5');

  console.log('activation queue ok');
})().catch((e) => { console.error(e); process.exit(1); });
