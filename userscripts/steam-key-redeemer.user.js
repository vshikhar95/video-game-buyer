// ==UserScript==
// @name         IndieGala + Humble + Fanatical -> Steam Key Auto-Redeemer
// @namespace    shikhar-indiegala-steam
// @version      2.2.0
// @description  Collect Steam keys from IndieGala (library page) or Humble Bundle (Keys page = whole account, or a single bundle's /downloads?key= page, via Humble's JSON API) or Fanatical (orders page or a single order, via Fanatical's account API), check Steam ownership, log already-owned keys to a Google Sheet, and auto-activate not-owned keys on Steam (base games first, DLC second) via Enhanced Steam's "Activate Multiple Products". Failed/rate-limited activations are logged to a "Not Activated" sheet tab so nothing gets lost.
// @author       vshikhar95
// @homepageURL  https://github.com/vshikhar95/video-game-buyer
// @updateURL    https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/steam-key-redeemer.user.js
// @downloadURL  https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/steam-key-redeemer.user.js
// @match        https://www.indiegala.com/*
// @match        https://www.humblebundle.com/*
// @match        https://www.fanatical.com/*
// @match        https://store.steampowered.com/account/registerkey*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      api.steampowered.com
// @connect      store.steampowered.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Config. First run will prompt you for these once and store them
  // locally via GM_setValue - they are never hardcoded in this file.
  // ---------------------------------------------------------------------

  const APPDETAILS_DELAY_MS = 500; // delay between Steam store appdetails calls (rate-limit friendly)
  const ORDER_FETCH_DELAY_MS = 250; // delay between Humble order API calls
  const ORDER_BATCH_SIZE = 40; // orders per /api/v1/orders request
  const PHASE_GAP_MS = 8000; // wait between activating base-game batch and DLC batch
  // Revealing is irreversible (on Humble it kills the gift link), and Steam rate-limits
  // activations (~50/hour). So only reveal this many not-owned keys per run; re-run for the rest.
  const MAX_REVEALS_PER_RUN = 40;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(fn, timeoutMs = 15000, intervalMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(intervalMs);
    }
    return null;
  }

  function gmFetch(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(
        Object.assign({}, opts, {
          onload: (res) => resolve(res),
          // GM error objects have no .message; wrap so logs say what failed instead of 'undefined'.
          onerror: (err) => reject(new Error('network error calling ' + opts.url + (err && err.error ? ': ' + err.error : ''))),
          ontimeout: () => reject(new Error('request timed out: ' + opts.url)),
        })
      );
    });
  }

  function ensureConfig() {
    let apiKey = GM_getValue('steamApiKey');
    let steamId = GM_getValue('steamId64');
    let sheetToken = GM_getValue('sheetToken');
    let sheetEndpoint = GM_getValue('sheetEndpoint');

    if (!apiKey) {
      apiKey = (prompt('Steam Web API key (from steamcommunity.com/dev/apikey):') || '').trim();
      if (apiKey) GM_setValue('steamApiKey', apiKey);
    }
    if (!steamId) {
      steamId = (prompt('Your SteamID64 (numeric, e.g. 7656119...):') || '').trim();
      if (steamId) GM_setValue('steamId64', steamId);
    }
    if (!sheetEndpoint) {
      sheetEndpoint = (prompt('Google Apps Script web app URL (ends in /exec):') || '').trim();
      if (sheetEndpoint) GM_setValue('sheetEndpoint', sheetEndpoint);
    }
    if (!sheetToken) {
      sheetToken = (prompt('Sheet ingest secret token:') || '').trim();
      if (sheetToken) GM_setValue('sheetToken', sheetToken);
    }
    return {
      apiKey: GM_getValue('steamApiKey'),
      steamId: GM_getValue('steamId64'),
      sheetToken: GM_getValue('sheetToken'),
      sheetEndpoint: GM_getValue('sheetEndpoint'),
    };
  }

  // ---------------------------------------------------------------------
  // Store sources. Each one lists Steam keys as
  //   { appid, title, key (null if not yet revealed), ref (id shown in sheet if unrevealed) }
  // and knows how to reveal one. runScan() below is shared by both.
  // ---------------------------------------------------------------------

  // --- IndieGala: scrape library rows on the current page ---------------
  const IG_ROW_SELECTOR = 'li.profile-private-page-library-subitem';
  const IG_TITLE_SELECTOR = '.profile-private-page-library-title-row-full';
  const IG_KEY_INPUT_SELECTOR = 'input.profile-private-page-library-key-serial';
  const IG_STEAM_LINK_SELECTOR = 'a[href*="store.steampowered.com/app/"]';

  function findByText(root, selector, text) {
    return Array.from(root.querySelectorAll(selector)).find(
      (el) => el.children.length === 0 && el.textContent.trim() === text
    );
  }

  function igRows() {
    return Array.from(document.querySelectorAll(IG_ROW_SELECTOR));
  }

  function igTitle(row, appid) {
    const known = row.querySelector(IG_TITLE_SELECTOR);
    if (known && known.textContent.trim()) return known.textContent.trim();
    // href looks like https://store.steampowered.com/app/123456/Some_Game_Name/
    const a = row.querySelector(IG_STEAM_LINK_SELECTOR);
    const m = a && (a.getAttribute('href') || '').match(/\/app\/\d+\/([^/]+)\/?/);
    if (m) return decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
    return '(unknown title, appid ' + (appid || '?') + ')';
  }

  async function igReveal(item, log) {
    const row = item.row;
    const trigger = findByText(row, 'a,button,div,span', 'Click to redeem key');
    if (!trigger) {
      log('  no "Click to redeem key" control found in this row');
      return null;
    }
    trigger.click();

    const proceed = await waitFor(() => findByText(row, 'a,button,div,span', 'Proceed'), 6000);
    if (!proceed) {
      log('  confirm dialog ("Proceed") did not appear');
      return null;
    }
    proceed.click();

    const key = await waitFor(() => {
      const inp = row.querySelector(IG_KEY_INPUT_SELECTOR);
      return inp && inp.value && inp.value.trim() ? inp.value.trim() : null;
    }, 20000);
    if (!key) log('  key never appeared after Proceed (timed out)');
    return key;
  }

  const INDIEGALA = {
    name: 'IndieGala',
    revealDelayMs: 400,
    isActive: () => location.hostname === 'www.indiegala.com' && igRows().length > 0,
    async listKeys(log) {
      const rows = igRows();
      log('Found ' + rows.length + ' key row(s) on this page.');
      return rows.map((row) => {
        const a = row.querySelector(IG_STEAM_LINK_SELECTOR);
        const m = a && (a.getAttribute('href') || '').match(/\/app\/(\d+)/);
        const appid = m ? Number(m[1]) : null;
        const inp = row.querySelector(IG_KEY_INPUT_SELECTOR);
        return {
          appid,
          title: igTitle(row, appid),
          key: inp && inp.value && inp.value.trim() ? inp.value.trim() : null,
          ref: '(unrevealed on IndieGala)',
          row,
        };
      });
    },
    reveal: igReveal,
  };

  // --- Humble: list Steam keys via JSON API ------------------------------
  // (same-origin fetch, so the logged-in session cookies come along for free)
  // ---------------------------------------------------------------------
  async function humbleJson(path) {
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) throw new Error('Humble ' + path + ' -> HTTP ' + res.status);
    return res.json();
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Region + expiry columns for the sheet (OnlyInCountries / ExceptCountries / Expiring).
  // Humble lists region locks per key as ISO country-code arrays; both empty = worldwide.
  // num_days_until_expired is -1 (or missing) when the key never expires.
  function humbleSheetFields(t) {
    const days = t.num_days_until_expired;
    return {
      onlyInCountries: (t.exclusive_countries || []).join(' | '), // sheet convention: 'IN | TR'
      exceptCountries: (t.disallowed_countries || []).join(' | '),
      expiring: typeof days === 'number' && days >= 0
        ? sheetDate(new Date(Date.now() + days * 864e5))
        : '',
    };
  }

  // Sheet convention: 04-Nov-2026
  function sheetDate(d) {
    const mon = d.toLocaleString('en-US', { month: 'short' });
    return String(d.getDate()).padStart(2, '0') + '-' + mon + '-' + d.getFullYear();
  }

  // Picks the sheet's region/expiry fields off an item (blank for IndieGala).
  function sheetFields(item) {
    return {
      onlyInCountries: item.onlyInCountries || '',
      exceptCountries: item.exceptCountries || '',
      expiring: item.expiring || '',
    };
  }

  function humbleBundlePageKey() {
    return location.pathname.startsWith('/downloads') ? new URLSearchParams(location.search).get('key') : null;
  }

  async function fetchHumbleSteamKeys(log) {
    // On a bundle page (/downloads?key=<gamekey>) only that order; on /home/keys, the whole account.
    const pageKey = humbleBundlePageKey();
    const orders = pageKey ? [{ gamekey: pageKey }] : await humbleJson('/api/v1/user/order?ajax=true');
    log('Found ' + orders.length + ' Humble order(s). Fetching keys...');

    // Batch endpoint: one request per ORDER_BATCH_SIZE orders instead of one per order.
    // Response is an object keyed by gamekey.
    const keys = [];
    for (let i = 0; i < orders.length; i += ORDER_BATCH_SIZE) {
      const batch = orders.slice(i, i + ORDER_BATCH_SIZE).map((o) => o.gamekey);
      log('  orders ' + (i + 1) + '-' + (i + batch.length) + ' of ' + orders.length + '...');
      let byGamekey;
      try {
        const qs = batch.map((g) => 'gamekeys=' + encodeURIComponent(g)).join('&');
        byGamekey = await humbleJson('/api/v1/orders?all_tpkds=true&' + qs);
      } catch (e) {
        log('  could not read this batch of orders: ' + e.message);
        continue;
      }
      for (const [gamekey, order] of Object.entries(byGamekey || {})) {
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        for (const t of tpks) {
          if (t.key_type !== 'steam' || t.is_expired) continue;
          keys.push({
            appid: t.steam_app_id ? Number(t.steam_app_id) : null,
            title: t.human_name || t.machine_name,
            key: t.redeemed_key_val || null, // null = not yet revealed on Humble
            machineName: t.machine_name,
            gamekey: t.gamekey || gamekey,
            keyindex: t.keyindex,
            ref: '(unrevealed) ' + (t.gamekey || gamekey) + '#' + t.keyindex,
            ...humbleSheetFields(t),
          });
        }
      }
      await sleep(ORDER_FETCH_DELAY_MS);
    }
    return keys;
  }

  async function revealHumbleKey(item) {
    const csrf = getCookie('csrf_cookie');
    if (!csrf) throw new Error('csrf_cookie not readable - are you logged in?');
    const res = await fetch('/humbler/redeemkey', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'CSRF-Prevention-Token': csrf,
      },
      body: new URLSearchParams({ keytype: item.machineName, key: item.gamekey, keyindex: item.keyindex }),
    });
    const obj = await res.json().catch(() => ({}));
    return obj.success && obj.key ? obj.key : null;
  }

  const HUMBLE = {
    name: 'Humble',
    revealDelayMs: 1500, // Humble throttles redeemkey
    isActive: () =>
      location.hostname === 'www.humblebundle.com' &&
      (location.pathname.startsWith('/home/keys') || !!humbleBundlePageKey()),
    listKeys: fetchHumbleSteamKeys,
    reveal: revealHumbleKey,
  };

  // --- Fanatical: list Steam keys via Fanatical's account API ------------
  // Auth is the token Fanatical's own pages keep in localStorage.bsauth, sent as the
  // `authorization` header. Reveal mirrors the site's "Reveal key" button:
  // POST /api/user/orders/redeem {oid, bid, pid, serialId, iid, atok}, which returns {key}.
  // For a game inside a bundle, bid = the bundle item's _id; for a single game, bid = ''.
  function fanaticalToken() {
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem('bsauth') || 'null'); } catch (e) {}
    if (!auth || !auth.token) throw new Error('not logged in to Fanatical');
    return auth.token;
  }

  async function fanaticalJson(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { authorization: fanaticalToken(), ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error('Fanatical ' + path + ' -> HTTP ' + res.status);
    return res.json();
  }

  // Steam appid for a Fanatical game: Fanatical's product API by slug, else an exact-name
  // match on Steam's store search (bundle games often have no slug).
  async function fanaticalAppId(slug, name) {
    if (slug) {
      try {
        const p = await fetch('/api/products/' + encodeURIComponent(slug) + '/en').then((r) => (r.ok ? r.json() : null));
        if (p && p.steam && p.steam.id) return Number(p.steam.id);
      } catch (e) { /* fall through to name search */ }
    }
    try {
      const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const res = await gmFetch({
        method: 'GET',
        url: 'https://store.steampowered.com/api/storesearch/?l=english&cc=US&term=' + encodeURIComponent(name),
      });
      const hit = (JSON.parse(res.responseText).items || []).find((i) => norm(i.name) === norm(name));
      if (hit) return Number(hit.id);
    } catch (e) { /* no appid: treated as not owned */ }
    return null;
  }

  function fanaticalPageOrderId() {
    const m = location.pathname.match(/\/orders\/([0-9a-f]{24})/);
    return m ? m[1] : null;
  }

  async function fetchFanaticalSteamKeys(log) {
    // On a single order page only that order; on /orders, the whole account.
    const pageId = fanaticalPageOrderId();
    const ids = pageId ? [pageId] : (await fanaticalJson('/api/user/orders')).map((o) => o._id);
    log('Found ' + ids.length + ' Fanatical order(s). Fetching keys...');

    const keys = [];
    for (const oid of ids) {
      let order;
      try {
        order = await fanaticalJson('/api/user/orders/' + oid);
      } catch (e) {
        log('  could not read order ' + oid + ': ' + e.message);
        continue;
      }
      for (const item of order.items || []) {
        const entries = (item.bundles || []).length
          ? item.bundles.flatMap((b) => (b.games || []).map((g) => ({ g, bid: item._id })))
          : [{ g: item, bid: '' }];
        for (const { g, bid } of entries) {
          if (!g.drm || !g.drm.steam || !g.serialId) continue; // non-Steam or keyless: skip
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

    // Appid lookups only for unrevealed keys (revealed ones are skipped by runScan anyway).
    for (const k of keys) {
      if (k.key) continue;
      k.appid = await fanaticalAppId(k.slug, k.title);
      await sleep(250);
    }
    return keys;
  }

  async function revealFanaticalKey(item) {
    let atok = '';
    try { atok = JSON.parse(localStorage.getItem('bsatok') || '{}').value || ''; } catch (e) {}
    const r = await fanaticalJson('/api/user/orders/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid: item.oid, bid: item.bid, pid: item.pid, serialId: item.serialId, iid: item.iid, atok }),
    });
    return r && r.key && r.key !== 'error' ? r.key : null;
  }

  const FANATICAL = {
    name: 'Fanatical',
    revealDelayMs: 1100, // Fanatical's own UI throttles reveals to 1/sec
    isActive: () => location.hostname === 'www.fanatical.com' && /^\/[a-z]{2}\/orders/.test(location.pathname),
    listKeys: fetchFanaticalSteamKeys,
    reveal: revealFanaticalKey,
  };

  const SOURCES = [INDIEGALA, HUMBLE, FANATICAL];

  async function fetchOwnedAppIdSet(apiKey, steamId) {
    const url =
      'https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/' +
      '?key=' + encodeURIComponent(apiKey) +
      '&steamid=' + encodeURIComponent(steamId) +
      '&format=json&include_appinfo=false&include_played_free_games=true';
    const res = await gmFetch({ method: 'GET', url });
    const obj = JSON.parse(res.responseText);
    const games = (obj.response && obj.response.games) || [];
    return new Set(games.map((g) => g.appid));
  }

  async function classifyAppId(appid) {
    if (!appid) return { type: 'unknown', parentAppId: null };
    const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid;
    try {
      const res = await gmFetch({ method: 'GET', url });
      const obj = JSON.parse(res.responseText);
      const entry = obj[String(appid)];
      if (entry && entry.success && entry.data) {
        return {
          type: entry.data.type || 'unknown',
          parentAppId: entry.data.fullgame ? Number(entry.data.fullgame.appid) : null,
        };
      }
    } catch (e) {
      // fall through to default below
    }
    return { type: 'unknown', parentAppId: null };
  }

  async function postRowsToSheet(sheetToken, rows, sheetName) {
    if (!rows.length) return { ok: true, added: 0 };
    const body = JSON.stringify({ token: sheetToken, rows, sheetName: sheetName || undefined });
    const res = await gmFetch({
      method: 'POST',
      url: GM_getValue('sheetEndpoint'), // stored by ensureConfig, never in the code
      headers: { 'Content-Type': 'text/plain' },
      data: body,
    });
    return JSON.parse(res.responseText);
  }

  const NOT_ACTIVATED_SHEET = 'Not Activated';

  function buildPanel() {
    const btn = document.createElement('button');
    btn.textContent = 'Scan & Redeem Keys';
    Object.assign(btn.style, {
      position: 'fixed', top: '80px', right: '20px', zIndex: 999999,
      padding: '10px 16px', background: '#cb272c', color: '#fff',
      border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
      boxShadow: '0 2px 8px rgba(0,0,0,.3)', fontFamily: 'Arial, sans-serif',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed', top: '124px', right: '20px', zIndex: 999999,
      width: '380px', maxHeight: '65vh', overflowY: 'auto',
      background: '#1b1b1b', color: '#eee', fontSize: '12px', lineHeight: '1.5',
      padding: '10px', borderRadius: '6px', display: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,.5)', fontFamily: 'Consolas, monospace',
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    function log(msg) {
      const line = document.createElement('div');
      line.textContent = msg;
      panel.appendChild(line);
      panel.style.display = 'block';
      panel.scrollTop = panel.scrollHeight;
    }

    return { btn, panel, log };
  }

  // Reveals item.key in place via the store. Returns true if the item now has a key.
  async function revealItem(source, item, log) {
    if (item.key) return true;
    try {
      item.key = await source.reveal(item, log);
    } catch (e) {
      log('  ERROR revealing ' + item.title + ': ' + e.message);
    }
    await sleep(source.revealDelayMs);
    log(item.key ? '  revealed: ' + item.title : '  FAILED to reveal key for ' + item.title + ' - skipping');
    return !!item.key;
  }

  async function runScan(source, log) {
    const { apiKey, steamId, sheetToken, sheetEndpoint } = ensureConfig();
    if (!apiKey || !steamId || !sheetToken || !sheetEndpoint) {
      log('Missing Steam API key / SteamID64 / sheet token / sheet URL - aborting.');
      return;
    }

    // Only unrevealed keys: anything already revealed was acted on before (earlier run or by hand),
    // and re-processing it would re-log used keys as tradeable and duplicate sheet rows.
    const listed = await source.listKeys(log);
    const all = listed.filter((k) => !k.key);
    log('Found ' + listed.length + ' Steam key(s); skipping ' + (listed.length - all.length) + ' already revealed. Checking Steam ownership for ' + all.length + '...');
    if (!all.length) {
      log('No unrevealed keys. Done.');
      return;
    }
    const owned = await fetchOwnedAppIdSet(apiKey, steamId);

    // GetOwnedGames doesn't list DLC, and some keys have no appid (packages).
    // Those land in "not owned"; Steam rejects them if owned and they end up in the Not Activated tab.
    const ownedItems = all.filter((r) => r.appid && owned.has(r.appid));
    const notOwnedItems = all.filter((r) => !r.appid || !owned.has(r.appid));
    log('Already owned: ' + ownedItems.length + '. Not owned: ' + notOwnedItems.length + '.');

    if (ownedItems.length) {
      // Owned keys get revealed too: traders want plain Steam keys, not Humble gift links.
      // If a reveal fails, the row is still logged with its unrevealed ref so nothing is lost.
      for (const item of ownedItems) await revealItem(source, item, log);
      // ponytail: re-running logs these again; dedupe in the Apps Script if that gets noisy.
      log('Writing already-owned keys to the sheet...');
      const rowsForSheet = ownedItems.map((r) => ({
        title: r.title,
        key: r.key || r.ref,
        status: '', // Status is the sheet's trade column (Traded/Expired), so leave it blank
        ...sheetFields(r),
      }));
      // Never throw here: these keys are already revealed, and the next run skips revealed keys,
      // so a failed write must leave them visible in the panel rather than lose them.
      let result;
      try {
        result = await postRowsToSheet(sheetToken, rowsForSheet);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      log('Sheet write result: ' + JSON.stringify(result));
      if (!result || !result.ok) {
        log('!! SHEET WRITE FAILED - copy these keys manually:');
        rowsForSheet.forEach((r) => log('   ' + r.title + ' | ' + r.key));
      }
    }

    if (!notOwnedItems.length) {
      log('Nothing left to activate on Steam. Done.');
      return;
    }

    const batch = notOwnedItems.slice(0, MAX_REVEALS_PER_RUN);
    if (notOwnedItems.length > batch.length) {
      log('Capping this run at ' + batch.length + ' keys; re-run later for the remaining ' + (notOwnedItems.length - batch.length) + '.');
    }

    const toReveal = batch.filter((r) => !r.key);
    if (toReveal.length) log('Revealing ' + toReveal.length + ' key(s) on ' + source.name + ' (irreversible)...');
    const revealed = [];
    for (const item of batch) {
      if (await revealItem(source, item, log)) revealed.push(item);
    }

    log('Classifying ' + revealed.length + ' not-owned item(s) as game/DLC...');
    const classified = [];
    for (const item of revealed) {
      const info = await classifyAppId(item.appid);
      classified.push({ appid: item.appid, title: item.title, key: item.key, ...sheetFields(item), ...info });
      if (item.appid) await sleep(APPDETAILS_DELAY_MS);
    }

    const baseItems = classified.filter((c) => c.type !== 'dlc');
    const dlcItems = classified.filter((c) => c.type === 'dlc');
    log('Base games: ' + baseItems.length + ', DLC: ' + dlcItems.length);

    GM_setValue('pendingBase', baseItems);
    GM_setValue('pendingDlc', dlcItems);
    GM_setValue('pendingPhase', baseItems.length ? 'base' : dlcItems.length ? 'dlc' : null);

    if (baseItems.length || dlcItems.length) {
      log('Opening Steam activation page in a new tab...');
      GM_openInTab('https://store.steampowered.com/account/registerkey/', { active: true });
    }
  }

  function initStorePage() {
    const source = SOURCES.find((s) => s.isActive());
    if (!source) return;
    const { btn, log } = buildPanel();
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await runScan(source, log);
      } catch (e) {
        log('ERROR: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Steam registerkey side: auto-continue any pending activation phase
  // ---------------------------------------------------------------------
  function findByTextSteam(text) {
    return Array.from(document.querySelectorAll('a,button,div,span')).find(
      (el) => el.children.length === 0 && el.textContent.trim() === text
    );
  }

  async function openActivateMultiple() {
    const link = await waitFor(() => findByTextSteam('Activate Multiple Products'), 15000);
    if (!link) {
      throw new Error(
        'Could not find "Activate Multiple Products" - is the Enhanced Steam extension installed and enabled?'
      );
    }
    link.click();
    const textarea = await waitFor(() => document.querySelector('textarea'), 5000);
    if (!textarea) throw new Error('Textarea for product codes did not appear');
    return textarea;
  }

  async function submitKeyBatch(keys) {
    const textarea = await openActivateMultiple();
    textarea.value = keys.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);

    const submitBtn = await waitFor(() => findByTextSteam('Activate products'), 5000);
    if (!submitBtn) throw new Error('"Activate products" button not found');
    submitBtn.click();

    await waitFor(
      () => keys.some((k) => Array.from(document.querySelectorAll('li')).some((li) => li.textContent.includes(k))),
      25000
    );
    await sleep(1200);

    return keys.map((k) => {
      const li = Array.from(document.querySelectorAll('li')).find((li) => li.textContent.includes(k));
      if (!li) return { key: k, ok: null, message: 'no result row found' };
      const text = li.textContent.trim();
      return { key: k, ok: text.includes('Successfully activated'), message: text };
    });
  }

  async function initRegisterKeyPage() {
    const phase = GM_getValue('pendingPhase', null);
    if (!phase) return;

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed', top: '80px', right: '20px', zIndex: 999999,
      width: '420px', maxHeight: '70vh', overflowY: 'auto',
      background: '#1b1b1b', color: '#eee', fontSize: '12px', lineHeight: '1.5',
      padding: '10px', borderRadius: '6px',
      boxShadow: '0 2px 8px rgba(0,0,0,.5)', fontFamily: 'Consolas, monospace',
    });
    document.body.appendChild(panel);

    function log(msg) {
      const line = document.createElement('div');
      line.textContent = msg;
      panel.appendChild(line);
      panel.scrollTop = panel.scrollHeight;
    }

    log('Pending activation phase: ' + phase);
    await sleep(1500); // let the page settle

    const sheetToken = GM_getValue('sheetToken');

    async function saveFailed(failedRows) {
      if (!failedRows.length) return;
      log('Saving ' + failedRows.length + ' not-activated key(s) to the "' + NOT_ACTIVATED_SHEET + '" sheet...');
      let result;
      try {
        result = await postRowsToSheet(sheetToken, failedRows, NOT_ACTIVATED_SHEET);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      log('  ' + JSON.stringify(result));
      if (!result || !result.ok) {
        // Re-running won't recover these (revealed keys are skipped), so print them to copy by hand.
        log('!! SHEET WRITE FAILED - copy these keys manually:');
        failedRows.forEach((r) => log('   ' + r.title + ' | ' + r.key));
      }
    }

    // Runs one batch (base or dlc). Never throws: on any error (including the
    // whole activation modal failing to open, e.g. due to a rate limit),
    // every key in this batch is treated as not-activated and reported back
    // so nothing silently disappears.
    async function runBatch(storageKey, label) {
      const items = GM_getValue(storageKey, []);
      if (!items.length) return { attempted: 0, failed: [] };

      log('Activating ' + items.length + ' ' + label + ' key(s)...');
      let results;
      try {
        results = await submitKeyBatch(items.map((i) => i.key));
      } catch (e) {
        log('  batch could not be submitted: ' + e.message);
        results = items.map((i) => ({ key: i.key, ok: false, message: 'batch error: ' + e.message }));
      }

      const byKey = {};
      items.forEach((i) => { byKey[i.key] = i; });

      results.forEach((r) => log((r.ok ? 'OK   ' : 'FAIL ') + r.key + ' - ' + r.message));

      const failed = results
        .filter((r) => !r.ok)
        .map((r) => {
          const item = byKey[r.key] || {};
          return {
            title: item.title || '(unknown title)',
            key: r.key,
            status: 'NOT ACTIVATED: ' + r.message,
            ...sheetFields(item),
          };
        });

      GM_setValue(storageKey, []);
      return { attempted: items.length, failed };
    }

    if (phase === 'base') {
      const baseResult = await runBatch('pendingBase', 'base-game');
      await saveFailed(baseResult.failed);

      const dlcItems = GM_getValue('pendingDlc', []);
      if (dlcItems.length) {
        GM_setValue('pendingPhase', 'dlc');
        log('Waiting ' + PHASE_GAP_MS / 1000 + 's before activating DLC batch...');
        await sleep(PHASE_GAP_MS);
        const dlcResult = await runBatch('pendingDlc', 'DLC');
        await saveFailed(dlcResult.failed);
      }
      GM_setValue('pendingPhase', null);
      log('All done.');
    } else if (phase === 'dlc') {
      const dlcResult = await runBatch('pendingDlc', 'DLC');
      await saveFailed(dlcResult.failed);
      GM_setValue('pendingPhase', null);
      log('All done.');
    }
  }

  // ---------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------
  if (['www.indiegala.com', 'www.humblebundle.com', 'www.fanatical.com'].includes(location.hostname)) {
    initStorePage();
  } else if (
    location.hostname === 'store.steampowered.com' &&
    location.pathname.indexOf('/account/registerkey') === 0
  ) {
    initRegisterKeyPage();
  }
})();
