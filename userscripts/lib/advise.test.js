// Run: node userscripts/lib/advise.test.js  (match cache only; no network)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const ctx = {
  URL,
  GM_getValue: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
  GM_setValue: (k, v) => { store[k] = v; },
};
vm.createContext(ctx);
vm.runInContext(['core.js', 'math.js', 'advise.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n') +
  '\n;this.x = { loadMatchCache, applyMatchCache, saveMatchCache, matchKey };', ctx);
const { loadMatchCache, applyMatchCache, saveMatchCache, matchKey } = ctx.x;

const day = 864e5;
const t0 = Date.UTC(2026, 9, 21);

// Only confident matches are saved: exact (ITAD bundle data) and maker-confirmed.
saveMatchCache([
  { title: 'THRESHOLD', makers: ['Julien Eveillé', 'CRITICAL REFLEX'], appid: 2580020, match: 'maker' },
  { title: 's.p.l.i.t', makers: [], appid: 3684610 }, // exact
  { title: 'Kiosk', makers: ['Vivi'], appid: 3126330, match: 'name' }, // name only: not cached
  { title: 'Doom', makers: [], appid: null, match: 'ambiguous' }, // not cached
], {}, t0);
assert.deepStrictEqual(Object.keys(store.matchCache).length, 2);

// Hits fill appids and keep the confidence; misses stay unresolved.
const games = [
  { title: 'Threshold', makers: ['CRITICAL REFLEX', 'Julien Eveillé'], appid: null }, // same key: case/order-insensitive
  { title: 's.p.l.i.t', makers: [], appid: null },
  { title: 'Kiosk', makers: ['Vivi'], appid: null },
];
assert.strictEqual(applyMatchCache(games, loadMatchCache(t0 + day)), 2);
assert.deepStrictEqual(games.map((g) => [g.appid, g.match]), [[2580020, 'maker'], [3684610, undefined], [null, undefined]]);

// Different makers = different key (a same-name game from another studio isn't a hit).
assert.notStrictEqual(matchKey({ title: 'THRESHOLD', makers: ['Fuse.fun'] }), matchKey(games[0]));

// Entries older than 30 days are pruned on load.
assert.strictEqual(Object.keys(loadMatchCache(t0 + 29 * day)).length, 2);
assert.strictEqual(Object.keys(loadMatchCache(t0 + 31 * day)).length, 0);

console.log('match cache ok');
