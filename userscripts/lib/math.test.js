// Run: node userscripts/lib/math.test.js
const assert = require('assert');
const { toInr, pickCost, bestPicks } = require('./math.js');

// Fanatical receipt: $6.99 paid ₹696.70 via PayPal at a ~95.05 market rate -> ~4.9% markup.
assert.strictEqual(Math.round(toInr(6.99, 'USD', { usdInr: 95.05, fxMarkup: 0.0486 })), 697);
// Humble-style GST on top, and INR prices pass through untouched.
assert.strictEqual(toInr(13, 'USD', { taxRate: 0.18, usdInr: 1 }).toFixed(2), '15.34');
assert.strictEqual(toInr(500, 'INR', { usdInr: 95 }), 500);

// Same cases as verdict.py _check(), with tier prices already in INR (2.0 USD * 100 = 200).
const c = [{ id: 'a', value: 500 }, { id: 'b', value: 300 }, { id: 'c', value: 50 }, { id: 'd', value: 40 }];
let r = bestPicks(c, [{ qty: 2, price: 200 }, { qty: 4, price: 300 }]);
assert.deepStrictEqual([r.n, r.cost, r.value], [2, 200, 800]); // 600 net beats 590
assert.strictEqual(bestPicks(c, [{ qty: 2, price: 200 }]).n, 2); // 3rd pick's 50 < 100 per pick: stop
assert.strictEqual(bestPicks(c, [{ qty: 2, price: 40 }]).n, 4); // 20 per pick: in-between counts allowed
assert.strictEqual(bestPicks(c.slice(0, 1), [{ qty: 2, price: 200 }]), null);
assert.strictEqual(pickCost(1, [{ qty: 3, price: 600 }]), null);
assert.deepStrictEqual(pickCost(6, [{ qty: 3, price: 600 }, { qty: 5, price: 900 }]), { cost: 1080, buy: 6 }); // 6 * 900/5

// Popular Picks (INR): 6 wanted picks cost 1,077 at the 5-tier rate, but a filler pick
// reaches the 7-tier for 1,047 when the pool has one.
const pp = [{ qty: 3, price: 598 }, { qty: 5, price: 897 }, { qty: 7, price: 1047 }];
assert.deepStrictEqual(pickCost(6, pp, 9), { cost: 1047, buy: 7 });
assert.strictEqual(Math.round(pickCost(6, pp, 6).cost), 1076); // no filler available
// One wanted pick in a 1-pick-minimum pool can't be bought without fillers at a 3-minimum.
assert.deepStrictEqual(pickCost(1, pp, 9), { cost: 598, buy: 3 });
const r2 = bestPicks([{ value: 900 }], pp, 9); // 1 great pick + 2 fillers beats nothing
assert.deepStrictEqual([r2.n, r2.buy, r2.cost], [1, 3, 598]);

console.log('math ok');
