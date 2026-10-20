// Humble Bundle. Same-origin fetches carry the logged-in session cookies.
// API details (order endpoints, humbler/redeemkey + CSRF header) as documented by
// FailSpy/humble-steam-key-redeemer.
(function () {
  const ORDER_FETCH_DELAY_MS = 250;
  const ORDER_BATCH_SIZE = 40; // orders per /api/v1/orders request

  async function humbleJson(path) {
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) throw new Error('Humble ' + path + ' -> HTTP ' + res.status);
    return res.json();
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Region + expiry columns for the sheet. Region locks are ISO country-code arrays (both
  // empty = worldwide); num_days_until_expired is -1 (or missing) when the key never expires.
  function sheetFieldsFor(t) {
    const days = t.num_days_until_expired;
    return {
      onlyInCountries: (t.exclusive_countries || []).join(' | '),
      exceptCountries: (t.disallowed_countries || []).join(' | '),
      expiring: typeof days === 'number' && days >= 0 ? sheetDate(new Date(Date.now() + days * 864e5)) : '',
    };
  }

  function downloadsPageKey() {
    return location.pathname.startsWith('/downloads') ? new URLSearchParams(location.search).get('key') : null;
  }

  // --- redeem: /home/keys (whole account) or a bundle's /downloads?key= page ---
  async function listKeys(log) {
    const pageKey = downloadsPageKey();
    const orders = pageKey ? [{ gamekey: pageKey }] : await humbleJson('/api/v1/user/order?ajax=true');
    log('Found ' + orders.length + ' Humble order(s). Fetching keys...');

    // Batch endpoint: one request per ORDER_BATCH_SIZE orders, keyed by gamekey.
    const keys = [];
    for (let i = 0; i < orders.length; i += ORDER_BATCH_SIZE) {
      const batch = orders.slice(i, i + ORDER_BATCH_SIZE).map((o) => o.gamekey);
      log('  orders ' + (i + 1) + '-' + (i + batch.length) + ' of ' + orders.length + '...');
      let byGamekey;
      try {
        byGamekey = await humbleJson('/api/v1/orders?all_tpkds=true&' + batch.map((g) => 'gamekeys=' + encodeURIComponent(g)).join('&'));
      } catch (e) {
        log('  could not read this batch of orders: ' + e.message);
        continue;
      }
      for (const [gamekey, order] of Object.entries(byGamekey || {})) {
        for (const t of (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || []) {
          if (t.key_type !== 'steam' || t.is_expired) continue;
          keys.push({
            appid: t.steam_app_id ? Number(t.steam_app_id) : null,
            title: t.human_name || t.machine_name,
            key: t.redeemed_key_val || null, // null = not yet revealed on Humble
            machineName: t.machine_name,
            gamekey: t.gamekey || gamekey,
            keyindex: t.keyindex,
            ref: '(unrevealed) ' + (t.gamekey || gamekey) + '#' + t.keyindex,
            ...sheetFieldsFor(t),
          });
        }
      }
      await sleep(ORDER_FETCH_DELAY_MS);
    }
    return keys;
  }

  async function reveal(item) {
    const csrf = getCookie('csrf_cookie');
    if (!csrf) throw new Error('csrf_cookie not readable - are you logged in?');
    const res = await fetch('/humbler/redeemkey', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'CSRF-Prevention-Token': csrf },
      body: new URLSearchParams({ keytype: item.machineName, key: item.gamekey, keyindex: item.keyindex }),
    });
    const obj = await res.json().catch(() => ({}));
    return obj.success && obj.key ? obj.key : null;
  }

  // --- advise: /games/<slug> bundle pages --------------------------------
  // Bundle data is the webpack-bundle-page-data JSON in the page HTML (the page removes the
  // tag after hydrating, so re-fetch the HTML). Items carry no Steam appid; titles are
  // matched through IsThereAnyDeal. Tier prices are what Humble charges this visitor,
  // so for India they already include the 18% GST: taxRate stays 0.
  // Developer + publisher names; Humble sometimes packs several into one string.
  function makersOf(it) {
    return [...(it.developers || []).map((x) => x['developer-name']), ...(it.publishers || []).map((x) => x['publisher-name'])]
      .flatMap((s) => (s || '').split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function getBundle() {
    const html = await fetch(location.href, { credentials: 'include' }).then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const d = JSON.parse(doc.getElementById('webpack-bundle-page-data').textContent).bundleData;
    const items = d.tier_item_data;
    const isSteam = (it) => !!(it && it.availability_icons && it.availability_icons.delivery_to_platform &&
      it.availability_icons.delivery_to_platform['hb-steam']);
    const tiers = (d.tier_order || []).map((t) => {
      const price = d.tier_pricing_data[t]['price|money'];
      return {
        price: price.amount,
        currency: price.currency,
        items: (d.tier_display_data[t].tier_item_machine_names || [])
          .map((n) => items[n])
          .filter(isSteam)
          .map((it) => ({ title: it.human_name, games: [{ title: it.human_name, appid: null, makers: makersOf(it) }] })),
      };
    });
    const name = (d.basic_data && d.basic_data.human_name) || document.title;
    return { name, kind: 'fixed', currency: tiers.length ? tiers[0].currency : 'USD', taxRate: 0, tiers };
  }

  registerStore({
    id: 'humble',
    name: 'Humble',
    redeem: {
      revealDelayMs: 1500, // Humble throttles redeemkey
      isActive: () => location.hostname === 'www.humblebundle.com' && (location.pathname.startsWith('/home/keys') || !!downloadsPageKey()),
      listKeys,
      reveal,
    },
    advise: {
      isActive: () => location.hostname === 'www.humblebundle.com' && /^\/games\/[^/]+/.test(location.pathname),
      getBundle,
    },
  });
})();
