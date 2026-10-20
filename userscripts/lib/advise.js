// Store-agnostic bundle advisor: prices each unowned game against its Steam India historical
// low (IsThereAnyDeal) and shows, per tier, what each unowned game effectively costs.
// For pick & mix, recommends which picks to take. Store-specific bundle reading lives in
// stores/*.js (the `advise` capability); pricing math in lib/math.js.

const ITAD = 'https://api.isthereanydeal.com';
const STEAM_SHOP = 61;
const ADVISOR_CONFIG = { itadKey: 'IsThereAnyDeal API key (isthereanydeal.com/apps/my/):' };
// PayPal/card conversion over the market rate; a Fanatical receipt showed ~4.9%.
const DEFAULT_FX_MARKUP = 0.05;

const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const gameKey = (g) => (g.appid ? 'app/' + g.appid : 'title/' + g.title.toLowerCase());

async function usdInrRate() {
  const d = await gmJson('https://open.er-api.com/v6/latest/USD');
  return d.rates.INR;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// games: [{ title, appid|null }] -> Map(gameKey -> { appid, itadId, low, current, bundled })
// Games without an appid are matched by title, and their appid comes back from ITAD.
async function priceGames(games, key) {
  const q = '?key=' + encodeURIComponent(key);
  const info = new Map();
  for (const g of games) info.set(gameKey(g), { appid: g.appid || null, itadId: null, low: null, current: null, bundled: null });

  const withApp = games.filter((g) => g.appid);
  for (const part of chunks(withApp, 200)) {
    const ids = await gmJson(ITAD + '/lookup/id/shop/' + STEAM_SHOP + '/v1' + q, part.map((g) => 'app/' + g.appid));
    part.forEach((g) => { info.get(gameKey(g)).itadId = ids['app/' + g.appid] || null; });
  }

  const byTitle = games.filter((g) => !g.appid);
  for (const part of chunks(byTitle, 200)) {
    const ids = await gmJson(ITAD + '/lookup/id/title/v1' + q, part.map((g) => g.title));
    part.forEach((g) => { info.get(gameKey(g)).itadId = ids[g.title] || null; });
    const found = part.filter((g) => info.get(gameKey(g)).itadId);
    if (found.length) {
      const apps = await gmJson(ITAD + '/lookup/shop/' + STEAM_SHOP + '/id/v1', found.map((g) => info.get(gameKey(g)).itadId));
      found.forEach((g) => {
        const app = (apps[info.get(gameKey(g)).itadId] || []).find((s) => s.startsWith('app/'));
        if (app) info.get(gameKey(g)).appid = Number(app.slice(4));
      });
    }
  }

  const itadIds = [...new Set([...info.values()].map((v) => v.itadId).filter(Boolean))];
  for (const part of chunks(itadIds, 200)) {
    const d = await gmJson(ITAD + '/games/overview/v2' + q + '&country=IN&shops=' + STEAM_SHOP, part);
    const byId = new Map((d.prices || []).map((p) => [p.id, p]));
    for (const v of info.values()) {
      const p = v.itadId && byId.get(v.itadId);
      if (!p) continue;
      v.low = p.lowest ? p.lowest.price.amount : null;
      v.current = p.current ? p.current.price.amount : null;
      v.bundled = p.bundled;
    }
  }
  return info;
}

// --- Rendering --------------------------------------------------------------
const TD = 'padding:1px 6px 1px 0;vertical-align:top;';
const DIM = 'color:#777;';
const WARN = 'color:#f0ad4e;';
const GOOD = 'color:#8fd18f;';

function gameRow(g, p, status, perGame) {
  const owned = status === 'owned';
  const cheaper = !owned && perGame && p.low !== null && p.low < perGame;
  return el('tr', { style: owned ? DIM : '' },
    el('td', { style: TD }, owned ? 'owned' : status === 'wish' ? '★' : ''),
    el('td', { style: TD }, g.title + (p.appid ? '' : ' (?)')),
    el('td', { style: TD + 'text-align:right;' + (cheaper ? WARN : '') }, p.low === null ? '-' : inr(p.low)),
    el('td', { style: TD + 'text-align:right;' + DIM }, p.current === null ? '-' : inr(p.current)));
}

function table(rows) {
  return el('table', { style: 'border-collapse:collapse;width:100%;margin:4px 0 8px;' },
    el('tr', { style: DIM }, el('td', { style: TD }, ''), el('td', { style: TD }, 'game'),
      el('td', { style: TD + 'text-align:right;' }, 'IN low'), el('td', { style: TD + 'text-align:right;' }, 'now')),
    ...rows);
}

function renderFixed(bundle, ctx, out) {
  const seen = new Map();
  bundle.tiers.forEach((tier, i) => {
    const added = [];
    for (const item of tier.items) for (const g of item.games) {
      if (!seen.has(gameKey(g))) { seen.set(gameKey(g), g); added.push(g); }
    }
    const all = [...seen.values()];
    const unowned = all.filter((g) => ctx.status(g) !== 'owned');
    const cost = toInr(tier.price, bundle.currency, ctx.fx);
    const perGame = unowned.length ? cost / unowned.length : null;
    const value = unowned.reduce((s, g) => s + (ctx.price(g).low || 0), 0);
    out.appendChild(el('div', { style: 'margin-top:6px;font-weight:bold;' },
      (bundle.tiers.length > 1 ? 'Tier ' + (i + 1) + ': ' : '') + inr(cost) + ' for ' + unowned.length + ' unowned of ' + all.length +
      (perGame ? ' = ' + inr(perGame) + '/game' : '')));
    out.appendChild(el('div', { style: value > cost ? GOOD : WARN },
      'Unowned games\' India lows add up to ' + inr(value) + ' → ' + (value > cost ? 'worth it' : 'cheaper to wait for Steam sales')));
    out.appendChild(table(added.map((g) => gameRow(g, ctx.price(g), ctx.status(g), perGame))));
  });
  out.appendChild(el('div', { style: DIM }, 'Orange low = that game has sold for less on Steam India than its per-game cost here.'));
}

function renderPick(bundle, ctx, out) {
  const tiers = bundle.tiers.map((t) => ({ qty: t.qty, price: toInr(t.price, bundle.currency, ctx.fx) }));
  const candidates = bundle.pool
    .map((item) => {
      const unowned = item.games.filter((g) => ctx.status(g) !== 'owned');
      return { item, unowned, value: unowned.reduce((s, g) => s + (ctx.price(g).low || 0), 0) };
    })
    .filter((c) => c.unowned.length);
  const ownedPicks = bundle.pool.length - candidates.length;
  out.appendChild(el('div', {}, 'Tiers: ' + tiers.map((t) => t.qty + ' for ' + inr(t.price)).join(', ') + '. ' +
    candidates.length + ' of ' + bundle.pool.length + ' picks have games you don\'t own.'));

  const allCost = pickCost(candidates.length, tiers);
  const allGames = candidates.reduce((s, c) => s + c.unowned.length, 0);
  out.appendChild(el('div', { style: 'margin-top:6px;font-weight:bold;' }, 'Take all unowned: ' +
    (allCost === null ? 'not enough picks for the first tier'
      : candidates.length + ' picks for ' + inr(allCost) + ' = ' + inr(allCost / allGames) + '/game (' + allGames + ' games)')));

  const best = bestPicks(candidates, tiers);
  if (!best) return out.appendChild(el('div', { style: WARN }, 'Skip: fewer unowned picks than the first tier needs.'));
  const picked = new Set(best.picks);
  out.appendChild(el('div', { style: 'margin-top:6px;font-weight:bold;' + (best.value > best.cost ? GOOD : WARN) },
    'Recommended: ' + best.n + ' picks for ' + inr(best.cost) + ' (' + inr(best.perPick) + '/pick), India lows ' + inr(best.value) +
    (best.value > best.cost ? '' : ' → not worth it')));

  const rows = [...candidates].sort((a, b) => b.value - a.value).map((c) => {
    const take = picked.has(c);
    const label = c.item.title + (c.item.games.length > 1 ? ' [' + c.unowned.map((g) => g.title).join(', ') + ']' : '');
    const wish = c.unowned.some((g) => ctx.status(g) === 'wish');
    return el('tr', { style: take ? '' : DIM },
      el('td', { style: TD + (take ? GOOD : '') }, take ? 'take' : 'skip'),
      el('td', { style: TD }, (wish ? '★ ' : '') + label),
      el('td', { style: TD + 'text-align:right;' + (!take ? WARN : '') }, inr(c.value)));
  });
  out.appendChild(el('table', { style: 'border-collapse:collapse;width:100%;margin:4px 0 8px;' },
    el('tr', { style: DIM }, el('td', { style: TD }, ''), el('td', { style: TD }, 'pick'), el('td', { style: TD + 'text-align:right;' }, 'IN lows')),
    ...rows));
  out.appendChild(el('div', { style: DIM }, 'Skipped picks have sold for less on Steam India than the ' + inr(best.perPick) +
    ' per pick they would cost here.' + (ownedPicks ? ' ' + ownedPicks + ' picks are fully owned and left out.' : '')));
}

async function runAdvice(store, ui) {
  const cfg = getConfig(ADVISOR_CONFIG);
  if (!cfg) return ui.log('Missing IsThereAnyDeal API key.');
  ui.log('Reading bundle...');
  const bundle = await store.advise.getBundle();
  const items = bundle.kind === 'pick' ? bundle.pool : bundle.tiers.flatMap((t) => t.items);
  const games = [...new Map(items.flatMap((i) => i.games).map((g) => [gameKey(g), g])).values()];
  ui.log(bundle.name + ': ' + games.length + ' games. Looking up Steam India prices...');

  const [prices, steam, rate] = await Promise.all([priceGames(games, cfg.itadKey), steamUserData(), usdInrRate()]);
  const ctx = {
    fx: { taxRate: bundle.taxRate || 0, usdInr: rate, fxMarkup: Number(GM_getValue('fxMarkup', DEFAULT_FX_MARKUP)) },
    price: (g) => prices.get(gameKey(g)),
    status: (g) => {
      const app = prices.get(gameKey(g)).appid;
      return app && steam.owned.has(app) ? 'owned' : app && steam.wishlist.has(app) ? 'wish' : 'new';
    },
  };

  ui.panel.textContent = '';
  ui.panel.appendChild(el('div', { style: 'font-weight:bold;font-size:13px;' }, bundle.name));
  ui.panel.appendChild(el('div', { style: DIM }, 'USD→INR ' + rate.toFixed(2) + ' +' + Math.round(ctx.fx.fxMarkup * 100) + '% card/PayPal' +
    (ctx.fx.taxRate ? ', +' + Math.round(ctx.fx.taxRate * 100) + '% tax' : '') + '. ★ wishlisted, (?) not matched to Steam.'));
  (bundle.kind === 'pick' ? renderPick : renderFixed)(bundle, ctx, ui.panel);
}

// Runs on page load and again whenever the URL changes (Fanatical is a single-page app).
function runAdvisor() {
  let current = null;
  let ui = null;
  async function check() {
    if (location.href === current) return;
    current = location.href;
    if (ui) ui.remove();
    ui = null;
    const store = activeStore('advise');
    if (!store) return;
    ui = makePanel({ width: 460 });
    try {
      await runAdvice(store, ui);
    } catch (e) {
      ui.log('ERROR: ' + e.message);
    }
  }
  check();
  setInterval(check, 1000);
}
