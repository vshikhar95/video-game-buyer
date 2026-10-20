// Pure pricing math shared by the advisor (no DOM, no GM_*), so it can be checked in Node:
//   node userscripts/lib/math.test.js

// Cost of `price` (store currency, tax-exclusive) in INR, after tax and card/PayPal FX markup.
function toInr(price, currency, { taxRate = 0, usdInr, fxMarkup = 0 }) {
  const withTax = price * (1 + taxRate);
  return currency === 'INR' ? withTax : withTax * usdInr * (1 + fxMarkup);
}

// Pick & mix: buying n picks costs n * (per-pick rate of the highest tier n reaches).
// tiers: [{ qty, price }] in INR. Returns null below the first tier.
function pickCost(n, tiers) {
  const reached = tiers.filter((t) => t.qty <= n).sort((a, b) => b.qty - a.qty)[0];
  return reached ? (n * reached.price) / reached.qty : null;
}

// Pick & mix recommendation (ported from verdict.py best_picks): candidates sorted by value
// (sum of the pick's unowned games' Steam India lows) high to low; try every count from the
// first tier up and keep the one with the most value over cost.
// -> { n, cost, value, picks, perPick } or null when there aren't enough candidates.
function bestPicks(candidates, tiers) {
  const sorted = [...candidates].sort((a, b) => b.value - a.value);
  const min = Math.min(...tiers.map((t) => t.qty));
  let best = null;
  for (let n = min; n <= sorted.length; n++) {
    const cost = pickCost(n, tiers);
    const picks = sorted.slice(0, n);
    const value = picks.reduce((s, p) => s + p.value, 0);
    if (!best || value - cost > best.value - best.cost) best = { n, cost, value, picks, perPick: cost / n };
  }
  return best;
}

if (typeof module !== 'undefined') module.exports = { toInr, pickCost, bestPicks };
