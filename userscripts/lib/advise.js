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

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Comparable form of a store page URL: host + path, without a trailing slash or a
// language prefix like Fanatical's /en/.
function pageKey(u) {
  return u.host + u.pathname.replace(/^\/[a-z]{2}(?=\/)/, '').replace(/\/$/, '');
}

// The store page behind an ITAD bundle link. ITAD wraps it in an affiliate redirect:
// ?u= for Humble (impact), ?ued= for Fanatical (awin).
function bundlePageUrl(u) {
  try {
    const outer = new URL(u);
    return pageKey(new URL(outer.searchParams.get('u') || outer.searchParams.get('ued') || u));
  } catch (e) {
    return null;
  }
}

// Exact Steam appids for games the store names only by title. Finds this page's bundle on
// ITAD via "bundles containing <one of its games>" (ended ones included: ITAD's expiry dates
// can lag the store) and copies ITAD's curated mapping. Same-name games ("THRESHOLD",
// "s.p.l.i.t") are why this beats title lookup. Sets g.appid in place; returns how many.
async function fillAppIdsFromItadBundle(games, key) {
  const q = '?key=' + encodeURIComponent(key);
  const here = pageKey(new URL(location.href));
  const unnamed = games.filter((g) => !g.appid);
  for (const probe of unnamed.slice(0, 3)) {
    const ids = await gmJson(ITAD + '/lookup/id/title/v1' + q, [probe.title]);
    if (!ids[probe.title]) continue;
    const bundles = await gmJson(ITAD + '/games/bundles/v2' + q + '&id=' + ids[probe.title] + '&country=IN&expired=true');
    const b = (bundles || []).find((x) => bundlePageUrl(x.url) === here);
    if (!b) continue;
    const bGames = (b.tiers || []).flatMap((t) => t.games);
    const apps = await gmJson(ITAD + '/lookup/shop/' + STEAM_SHOP + '/id/v1', bGames.map((x) => x.id));
    const appByTitle = new Map();
    for (const x of bGames) {
      const app = (apps[x.id] || []).find((s) => s.startsWith('app/'));
      if (app) appByTitle.set(norm(x.title), Number(app.slice(4)));
    }
    let filled = 0;
    for (const g of unnamed) {
      const app = appByTitle.get(norm(g.title));
      if (app) { g.appid = app; filled++; }
    }
    return filled;
  }
  return 0;
}

// Fallback for games ITAD's bundle data didn't cover: exact-name search on Steam, checked
// against the developers/publishers the store lists (Steam search rarely returns two
// same-name games; the real risk is one result that's the wrong same-name game).
//   one or more exact-name matches, exactly one sharing a developer/publisher
//                              -> take it (g.match = 'maker', confirmed)
//   one match, store lists no makers or they don't line up
//                              -> take it (g.match = 'name', shown with ~)
//   several, none or several share a maker -> 'ambiguous', not guessed (shown as (?))
//   none (names differ)        -> left for ITAD's title lookup in priceGames
async function resolveByName(games) {
  const steamSearch = (title) =>
    gmJson('https://store.steampowered.com/api/storesearch/?l=english&cc=IN&term=' + encodeURIComponent(title))
      .then((d) => (d.items || []).filter((i) => norm(i.name) === norm(title)))
      .catch(() => []);
  const makersOfApp = (id) =>
    gmJson('https://store.steampowered.com/api/appdetails?filters=basic,developers,publishers&appids=' + id)
      .then((d) => { const x = (d[id] && d[id].data) || {}; return [...(x.developers || []), ...(x.publishers || [])].map(norm); })
      .catch(() => []);

  for (const g of games.filter((x) => !x.appid)) {
    const hits = await steamSearch(g.title);
    if (!hits.length) continue;
    const makers = new Set((g.makers || []).map(norm));
    const fits = [];
    if (makers.size) {
      for (const h of hits) if ((await makersOfApp(h.id)).some((m) => makers.has(m))) fits.push(Number(h.id));
    }
    if (fits.length === 1) {
      g.appid = fits[0];
      g.match = 'maker';
    } else if (hits.length === 1) {
      g.appid = Number(hits[0].id);
      g.match = 'name';
    } else {
      g.match = 'ambiguous';
    }
  }
}

// games: [{ title, appid|null, match? }] -> Map(gameKey -> { appid, itadId, low, current, bundled, match })
// match: undefined = exact ID from the store or ITAD's bundle data, 'maker' = confirmed by
// developer/publisher, 'name' = name only, 'ambiguous' = several same-name games (not guessed).
// Games still without an appid (and not ambiguous) get ITAD's title lookup as a last resort.
async function priceGames(games, key) {
  const q = '?key=' + encodeURIComponent(key);
  const info = new Map();
  for (const g of games) {
    info.set(gameKey(g), { appid: g.appid || null, itadId: null, low: null, current: null, bundled: null, match: g.appid ? g.match : g.match || 'name' });
  }

  const withApp = games.filter((g) => g.appid);
  for (const part of chunks(withApp, 200)) {
    const ids = await gmJson(ITAD + '/lookup/id/shop/' + STEAM_SHOP + '/v1' + q, part.map((g) => 'app/' + g.appid));
    part.forEach((g) => { info.get(gameKey(g)).itadId = ids['app/' + g.appid] || null; });
  }

  const byTitle = games.filter((g) => !g.appid && g.match !== 'ambiguous');
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
    el('td', { style: TD }, g.title + (!p.appid ? ' (?)' : p.match === 'name' ? ' ~' : '')),
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
  // Cheapest tier first, so the running union adds each tier's new games. Stores differ:
  // Humble lists its most expensive tier first, with every game it includes.
  const tiers = [...bundle.tiers].sort((a, b) => a.price - b.price);
  const seen = new Map();
  tiers.forEach((tier, i) => {
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
      (tiers.length > 1 ? 'Tier ' + (i + 1) + ': ' : '') + inr(cost) + ' for ' + unowned.length + ' unowned of ' + all.length +
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

  // Extra picks beyond the wanted ones, added only to reach a cheaper tier.
  const filler = (n, buy) => (buy > n ? ' (+' + (buy - n) + ' filler pick' + (buy - n > 1 ? 's' : '') + ' to reach the ' + buy + '-pick tier)' : '');
  const all = pickCost(candidates.length, tiers, bundle.pool.length);
  const allGames = candidates.reduce((s, c) => s + c.unowned.length, 0);
  out.appendChild(el('div', { style: 'margin-top:6px;font-weight:bold;' }, 'Take all unowned: ' +
    (!all || !allGames ? 'not possible with this pool'
      : candidates.length + ' picks for ' + inr(all.cost) + ' = ' + inr(all.cost / allGames) + '/game (' + allGames + ' games)' + filler(candidates.length, all.buy))));

  const best = bestPicks(candidates, tiers, bundle.pool.length);
  if (!best) return out.appendChild(el('div', { style: WARN }, 'Skip: not enough picks for the first tier.'));
  const picked = new Set(best.picks);
  out.appendChild(el('div', { style: 'margin-top:6px;font-weight:bold;' + (best.value > best.cost ? GOOD : WARN) },
    'Recommended: ' + best.n + ' picks for ' + inr(best.cost) + ' (' + inr(best.perPick) + '/pick), India lows ' + inr(best.value) +
    filler(best.n, best.buy) + (best.value > best.cost ? '' : ' → not worth it')));

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
  const raw = items.flatMap((i) => i.games);
  // Fill exact appids first: gameKey depends on appid, so this must happen before deduping.
  if (raw.some((g) => !g.appid)) {
    ui.log('Matching games to Steam via IsThereAnyDeal\'s bundle data...');
    try {
      ui.log('  exact Steam IDs for ' + (await fillAppIdsFromItadBundle(raw, cfg.itadKey)) + ' game(s)');
    } catch (e) {
      ui.log('  ITAD bundle lookup failed (' + e.message + '), falling back to name matching');
    }
    if (raw.some((g) => !g.appid)) {
      ui.log('Matching the rest by name on Steam (developer/publisher breaks ties)...');
      await resolveByName(raw);
    }
  }
  const games = [...new Map(raw.map((g) => [gameKey(g), g])).values()];
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

  // Click the title to collapse the panel out of the way.
  const body = el('div', {});
  ui.panel.textContent = '';
  ui.panel.appendChild(el('div', {
    style: 'font-weight:bold;font-size:13px;cursor:pointer;', title: 'Click to collapse/expand',
    onclick: () => { body.style.display = body.style.display === 'none' ? '' : 'none'; },
  }, '▾ ' + bundle.name));
  ui.panel.appendChild(body);
  body.appendChild(el('div', { style: DIM }, 'USD→INR ' + rate.toFixed(2) + ' +' + Math.round(ctx.fx.fxMarkup * 100) + '% card/PayPal' +
    (ctx.fx.taxRate ? ', +' + Math.round(ctx.fx.taxRate * 100) + '% tax' : '') + '. ★ wishlisted, ~ matched by name only, (?) not found or several same-name games on Steam.'));
  (bundle.kind === 'pick' ? renderPick : renderFixed)(bundle, ctx, body);
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
