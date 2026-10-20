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
assert.strictEqual(pickCost(6, [{ qty: 3, price: 600 }, { qty: 5, price: 900 }]), 1080); // 6 * 900/5

console.log('math ok');
