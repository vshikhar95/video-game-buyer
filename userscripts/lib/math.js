// Pure pricing math shared by the advisor (no DOM, no GM_*), so it can be checked in Node:
//   node userscripts/lib/math.test.js

// Cost of `price` (store currency, tax-exclusive) in INR, after tax and card/PayPal FX markup.
function toInr(price, currency, { taxRate = 0, usdInr, fxMarkup = 0 }) {
  const withTax = price * (1 + taxRate);
  return currency === 'INR' ? withTax : withTax * usdInr * (1 + fxMarkup);
}

// Pick & mix: buying m picks costs m * (per-pick rate of the highest tier m reaches).
// tiers: [{ qty, price }] in INR. Returns null below the first tier.
function rawPickCost(m, tiers) {
  const reached = tiers.filter((t) => t.qty <= m).sort((a, b) => b.qty - a.qty)[0];
  return reached ? (m * reached.price) / reached.qty : null;
}

// Cheapest way to get n wanted picks: you can add filler picks (any, even owned ones) up to
// poolSize when a bigger tier is cheaper overall, e.g. 7 for ₹1,047 beats 6 for ₹1,077.
// -> { cost, buy } (buy = total picks to put in the cart) or null below the first tier.
function pickCost(n, tiers, poolSize = n) {
  let best = null;
  for (let m = n; m <= Math.max(n, poolSize); m++) {
    const cost = rawPickCost(m, tiers);
    if (cost !== null && (!best || cost < best.cost)) best = { cost, buy: m };
  }
  return best;
}

// Pick & mix recommendation (ported from verdict.py best_picks): candidates sorted by value
// (sum of the pick's unowned games' Steam India lows) high to low; try every count and keep
// the one with the most value over cost.
// -> { n, buy, cost, value, picks, perPick } or null when no count reaches the first tier.
function bestPicks(candidates, tiers, poolSize = candidates.length) {
  const sorted = [...candidates].sort((a, b) => b.value - a.value);
  let best = null;
  for (let n = 1; n <= sorted.length; n++) {
    const c = pickCost(n, tiers, poolSize);
    if (!c) continue;
    const picks = sorted.slice(0, n);
    const value = picks.reduce((s, p) => s + p.value, 0);
    if (!best || value - c.cost > best.value - best.cost) best = { n, buy: c.buy, cost: c.cost, value, picks, perPick: c.cost / n };
  }
  return best;
}

if (typeof module !== 'undefined') module.exports = { toInr, pickCost, bestPicks };
