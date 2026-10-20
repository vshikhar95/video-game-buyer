// Run: node userscripts/lib/redeem.test.js  (activation queue; Steam and the sheet are stubbed)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const sheetRows = [];
const replies = {}; // key -> list of Steam replies, consumed in order
const ctx = {
  console, URLSearchParams, Date,
  document: { cookie: 'sessionid=abc123; other=1' },
  GM_getValue: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
  GM_setValue: (k, v) => { store[k] = v; },
  GM_openInTab: () => {},
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
    return { json: async () => reply };
  },
};
vm.createContext(ctx);
const code = ['core.js', 'redeem.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
// No real waiting in tests (later declarations win).
vm.runInContext(code + '\nasync function sleep() {}\n;this.x = { processQueue, enqueueKeys, parseActivation, getQueue };', ctx);
const { processQueue, enqueueKeys, parseActivation, getQueue } = ctx.x;

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
assert.strictEqual(enqueueKeys('ABCDEFG'.split('').map((k) => ({ title: 'T' + k, key: k }))), 7);
assert.strictEqual(enqueueKeys([{ title: 'TA', key: 'A' }]), 0); // no duplicates

const logs = [];
const log = (m) => logs.push(m);
(async () => {
  // Run 1: stops at F's rate limit.
  await processQueue(log);
  assert.deepStrictEqual(getQueue().map((k) => k.key), ['F', 'G', 'D']);
  assert.strictEqual(getQueue()[0].rateLimited, 1);
  assert.ok(store.rateLimitedUntil > Date.now() + 59 * 60 * 1000);
  assert.deepStrictEqual(sheetRows.map((r) => [r.key, r.sheet]), [['B', 'Steam Keys'], ['C', 'Steam Keys'], ['E', 'Not Activated']]);
  assert.strictEqual(sheetRows[0].status, ''); // spare: trade column left blank
  assert.match(sheetRows[1].status, /region/);
  assert.match(logs[logs.length - 1], /rate limit.*3 key\(s\) left/);

  // Run 2 while paused: does nothing.
  await processQueue(log);
  assert.strictEqual(getQueue().length, 3);

  // Run 3 after the pause: F and G activate, D fails for good.
  store.rateLimitedUntil = 0;
  store.activationLock = null;
  await processQueue(log);
  assert.deepStrictEqual(getQueue(), []);
  assert.deepStrictEqual(sheetRows.slice(3).map((r) => [r.key, r.sheet]), [['D', 'Not Activated']]);
  assert.ok(logs.some((m) => /OK +TF/.test(m)) && logs.some((m) => /OK +TG/.test(m)));

  // A key that is "rate limited" every time is reported after the retry cap, not retried forever.
  replies.H = [fail(53), fail(53), fail(53), fail(53)];
  enqueueKeys([{ title: 'TH', key: 'H' }]);
  for (let i = 0; i < 4; i++) { store.rateLimitedUntil = 0; await processQueue(log); }
  assert.deepStrictEqual(getQueue(), []);
  assert.deepStrictEqual(sheetRows.slice(-1).map((r) => [r.key, r.sheet]), [['H', 'Not Activated']]);

  console.log('activation queue ok');
})().catch((e) => { console.error(e); process.exit(1); });
