// Shared, store-agnostic helpers for the redeemer and advisor userscripts.
// Loaded via @require; everything here is plain top-level declarations visible to the
// other @require files and the main script (Tampermonkey runs them in one scope).

// --- Store registry ------------------------------------------------------
// Each stores/*.js file calls registerStore({ id, name, redeem?, advise? }).
//   redeem: { isActive(), listKeys(log) -> [key], reveal(key, log) -> string|null, revealDelayMs }
//     key: { appid|null, title, key|null (null = unrevealed), ref, onlyInCountries?, exceptCountries?, expiring? }
//   advise: { isActive(), getBundle() -> bundle }
//     bundle: { name, kind: 'fixed'|'pick', currency, taxRate, tiers, pool? }
//       fixed: tiers [{ price, items }]   (tiers may repeat earlier items; they're unioned)
//       pick:  tiers [{ qty, price }], pool [item]
//       item:  { title, games: [game] }   (a pick can hold several games)
//       game:  { title, appid|null, makers?: [developer/publisher names] }
//              makers let the advisor tell same-name Steam games apart when appid is null.
const STORES = [];
function registerStore(store) {
  STORES.push(store);
}
function activeStore(capability) {
  return STORES.find((s) => s[capability] && s[capability].isActive());
}

// --- Small helpers -------------------------------------------------------
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

function findByText(root, selector, text) {
  return Array.from(root.querySelectorAll(selector)).find(
    (el) => el.children.length === 0 && el.textContent.trim() === text
  );
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

async function gmJson(url, body) {
  const res = await gmFetch(
    body === undefined
      ? { method: 'GET', url }
      : { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body) }
  );
  if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status + ' from ' + url.split('?')[0]);
  return JSON.parse(res.responseText);
}

// Asks once for each missing value and keeps it in Tampermonkey storage (never in the code).
// fields: { storageKey: 'prompt text' } -> { storageKey: value } or null if any is still missing.
function getConfig(fields) {
  const out = {};
  for (const [key, question] of Object.entries(fields)) {
    let v = GM_getValue(key);
    if (!v) {
      v = (prompt(question) || '').trim();
      if (v) GM_setValue(key, v);
    }
    if (!v) return null;
    out[key] = v;
  }
  return out;
}

// --- Panel UI ------------------------------------------------------------
// A fixed dark panel; with buttonText, a button above it starts hidden content.
function makePanel({ buttonText, top = 80, width = 380 } = {}) {
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', top: (buttonText ? top + 44 : top) + 'px', right: '20px', zIndex: 999999,
    width: width + 'px', maxHeight: '70vh', overflowY: 'auto',
    background: '#1b1b1b', color: '#eee', fontSize: '12px', lineHeight: '1.5',
    padding: '10px', borderRadius: '6px', display: buttonText ? 'none' : 'block',
    boxShadow: '0 2px 8px rgba(0,0,0,.5)', fontFamily: 'Consolas, monospace',
  });
  document.body.appendChild(panel);

  let btn = null;
  if (buttonText) {
    btn = document.createElement('button');
    btn.textContent = buttonText;
    Object.assign(btn.style, {
      position: 'fixed', top: top + 'px', right: '20px', zIndex: 999999,
      padding: '10px 16px', background: '#cb272c', color: '#fff',
      border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
      boxShadow: '0 2px 8px rgba(0,0,0,.3)', fontFamily: 'Arial, sans-serif',
    });
    document.body.appendChild(btn);
  }

  function log(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    panel.appendChild(line);
    panel.style.display = 'block';
    panel.scrollTop = panel.scrollHeight;
  }
  function remove() {
    panel.remove();
    if (btn) btn.remove();
  }
  return { panel, btn, log, remove };
}

// Tiny DOM builder: el('td', { style: 'color:red' }, 'text', childNode). Text is always textContent.
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

// --- Steam ---------------------------------------------------------------
// Owned apps (games and DLC) and wishlist from the store's userdata, using the browser's
// Steam login. Needs you to be logged in at store.steampowered.com.
async function steamUserData() {
  const res = await gmFetch({
    method: 'GET',
    url: 'https://store.steampowered.com/dynamicstore/userdata/?t=' + Date.now(),
    anonymous: false,
    headers: { Referer: 'https://store.steampowered.com/' },
  });
  const d = JSON.parse(res.responseText || '{}');
  const owned = new Set(d.rgOwnedApps || []);
  if (!owned.size) {
    throw new Error('Steam returned no owned games - log in at store.steampowered.com in this browser and retry.');
  }
  return { owned, wishlist: new Set(d.rgWishlist || []) };
}

// --- Google Sheet ----------------------------------------------------------
// Sheet conventions: dates like 04-Nov-2026, countries like 'IN | TR'.
function sheetDate(d) {
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return String(d.getDate()).padStart(2, '0') + '-' + mon + '-' + d.getFullYear();
}

async function postRowsToSheet(rows, sheetName) {
  if (!rows.length) return { ok: true, added: 0 };
  const body = JSON.stringify({ token: GM_getValue('sheetToken'), rows, sheetName: sheetName || undefined });
  const res = await gmFetch({
    method: 'POST',
    url: GM_getValue('sheetEndpoint'), // stored via getConfig, never in the code
    headers: { 'Content-Type': 'text/plain' },
    data: body,
  });
  return JSON.parse(res.responseText);
}
