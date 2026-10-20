// Fanatical. Account API auth is the token Fanatical's own pages keep in localStorage.bsauth,
// sent as the `authorization` header. Public product/bundle APIs need no auth.
(function () {
  const ORDER_FETCH_DELAY_MS = 250;

  function token() {
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem('bsauth') || 'null'); } catch (e) {}
    if (!auth || !auth.token) throw new Error('not logged in to Fanatical');
    return auth.token;
  }

  async function accountJson(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { authorization: token(), ...(opts.headers || {}) } });
    if (!res.ok) throw new Error('Fanatical ' + path + ' -> HTTP ' + res.status);
    return res.json();
  }

  async function publicJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('Fanatical ' + path + ' -> HTTP ' + res.status);
    return res.json();
  }

  // Steam appid for a Fanatical game: product API by slug, else an exact-name match on
  // Steam's store search (bundle games often have no slug).
  async function appIdFor(slug, name) {
    if (slug) {
      try {
        const p = await publicJson('/api/products/' + encodeURIComponent(slug) + '/en');
        if (p && p.steam && p.steam.id) return Number(p.steam.id);
      } catch (e) { /* fall through to name search */ }
    }
    try {
      const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const d = await gmJson('https://store.steampowered.com/api/storesearch/?l=english&cc=US&term=' + encodeURIComponent(name));
      const hit = (d.items || []).find((i) => norm(i.name) === norm(name));
      if (hit) return Number(hit.id);
    } catch (e) { /* no appid: treated as not owned */ }
    return null;
  }

  const isSteam = (p) => !!(p && p.drm && p.drm.steam);

  // --- redeem: orders page (whole account) or one order page ------------
  // Reveal mirrors the site's "Reveal key" button: POST /api/user/orders/redeem
  // {oid, bid, pid, serialId, iid, atok} -> {key}. For a game inside a bundle, bid = the
  // bundle item's _id; for a single game, bid = ''.
  async function listKeys(log) {
    const m = location.pathname.match(/\/orders\/([0-9a-f]{24})/);
    const ids = m ? [m[1]] : (await accountJson('/api/user/orders')).map((o) => o._id);
    log('Found ' + ids.length + ' Fanatical order(s). Fetching keys...');

    const keys = [];
    for (const oid of ids) {
      let order;
      try {
        order = await accountJson('/api/user/orders/' + oid);
      } catch (e) {
        log('  could not read order ' + oid + ': ' + e.message);
        continue;
      }
      for (const item of order.items || []) {
        const entries = (item.bundles || []).length
          ? item.bundles.flatMap((b) => (b.games || []).map((g) => ({ g, bid: item._id })))
          : [{ g: item, bid: '' }];
        for (const { g, bid } of entries) {
          if (!isSteam(g) || !g.serialId) continue; // non-Steam or keyless: skip
          if (g.mystery && !g.mysteryRevealed) continue; // ponytail: unopened mystery games skipped
          const revealed = g.key || g.status === 'revealed';
          keys.push({
            appid: null,
            slug: g.slug,
            title: g.name,
            key: revealed ? g.key || '(revealed)' : null,
            oid,
            bid,
            pid: g._id,
            serialId: g.serialId,
            iid: g.iid,
            ref: '(unrevealed) fanatical order ' + oid,
            expiring: g.serialExpiry ? sheetDate(new Date(g.serialExpiry)) : '',
          });
        }
      }
      await sleep(ORDER_FETCH_DELAY_MS);
    }

    // Appid lookups only for unrevealed keys (revealed ones are skipped anyway).
    for (const k of keys) {
      if (k.key) continue;
      k.appid = await appIdFor(k.slug, k.title);
      await sleep(250);
    }
    return keys;
  }

  async function reveal(item) {
    let atok = '';
    try { atok = JSON.parse(localStorage.getItem('bsatok') || '{}').value || ''; } catch (e) {}
    const r = await accountJson('/api/user/orders/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid: item.oid, bid: item.bid, pid: item.pid, serialId: item.serialId, iid: item.iid, atok }),
    });
    return r && r.key && r.key !== 'error' ? r.key : null;
  }

  // --- advise: /<lang>/pick-and-mix/<slug> and /<lang>/bundle/<slug> ------
  // Prices are USD cents. A pick can be a multi-game pack (bundleGames: name + slug only).
  // Only exact IDs here (product API); games without one are left to the advisor's
  // ITAD-bundle / name matching, which marks name-only matches.
  async function exactAppId(slug) {
    try {
      const p = await publicJson('/api/products/' + encodeURIComponent(slug) + '/en');
      return p && p.steam && p.steam.id ? Number(p.steam.id) : null;
    } catch (e) {
      return null;
    }
  }

  async function packGames(p) {
    if (!(p.bundleGames || []).length) return [{ title: p.name, appid: p.steam && p.steam.id ? Number(p.steam.id) : null }];
    return Promise.all(p.bundleGames.map(async (g) => ({ title: g.name.trim(), appid: await exactAppId(g.slug) })));
  }

  // Pick & mix cart: each card's own "Add" / "Remove from bundle" button adds or removes the
  // pick in the basket directly (POST /api/basket), so the advisor just clicks those.
  const pickCards = () =>
    new Map(Array.from(document.querySelectorAll('.PickAndMixCard')).map((c) => [((c.querySelector('.card-product-name') || {}).textContent || '').trim(), c]));
  const isPicked = (card) => card.classList.contains('card-selected');
  const pickCart = {
    selected: () => new Set([...pickCards()].filter(([, c]) => isPicked(c)).map(([name]) => name)),
    // -> true if it clicked, false if the pick was already in that state
    async set(title, on) {
      const card = pickCards().get(title);
      if (!card) throw new Error('no card for "' + title + '" on the page');
      if (isPicked(card) === on) return false;
      const btn = Array.from(card.querySelectorAll('button.select-btn')).find((b) => b.offsetParent !== null);
      if (!btn) throw new Error('no Add/Remove button for "' + title + '"');
      btn.click();
      if (!(await waitFor(() => isPicked(card) === on, 8000))) throw new Error('Fanatical did not confirm "' + title + '"');
      return true;
    },
  };

  function bundlePage() {
    const m = location.pathname.match(/^\/[a-z]{2}\/(pick-and-mix|bundle)\/([^/?#]+)/);
    return m ? { kind: m[1], slug: m[2] } : null;
  }

  async function getBundle() {
    const page = bundlePage();
    if (page.kind === 'pick-and-mix') {
      const j = await publicJson('/api/pick-and-mix/' + page.slug + '/en');
      const pool = await Promise.all(j.products.filter(isSteam).map(async (p) => ({ title: p.name, games: await packGames(p) })));
      return {
        name: j.name, kind: 'pick', currency: 'USD', taxRate: 0, pool, cart: pickCart,
        tiers: j.tiers.map((t) => ({ qty: t.quantity, price: t.price.USD / 100 })),
      };
    }
    const g = await publicJson('/api/products-group/' + page.slug + '/en');
    return {
      name: g.name, kind: 'fixed', currency: 'USD', taxRate: 0,
      tiers: (g.bundles || []).map((b) => ({
        price: b.price.USD / 100,
        // Mystery slots have no known game until bought: nothing to price.
        items: (b.games || []).filter((x) => isSteam(x) && !x.mystery)
          .map((x) => ({ title: x.name, games: [{ title: x.name, appid: x.steam && x.steam.id ? Number(x.steam.id) : null }] })),
      })),
    };
  }

  registerStore({
    id: 'fanatical',
    name: 'Fanatical',
    redeem: {
      revealDelayMs: 1100, // Fanatical's own UI throttles reveals to 1/sec
      isActive: () => location.hostname === 'www.fanatical.com' && /^\/[a-z]{2}\/orders/.test(location.pathname),
      listKeys,
      reveal,
    },
    advise: {
      isActive: () => location.hostname === 'www.fanatical.com' && !!bundlePage(),
      getBundle,
    },
  });
})();
