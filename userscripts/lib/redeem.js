// Store-agnostic redeem flow: list unrevealed Steam keys from the active store, log owned ones
// to the sheet, reveal the rest and queue them; Steam's activation page then works through the
// queue with the same request Steam's own page uses, pausing for Steam's rate limit.
// Store-specific listing/revealing lives in stores/*.js (the `redeem` capability).

const APPDETAILS_DELAY_MS = 500; // delay between Steam store appdetails calls (rate-limit friendly)
const NOT_ACTIVATED_SHEET = 'Not Activated';
const ACTIVATED_SHEET = 'Activated';

// --- Local log -----------------------------------------------------------------
// Everything the redeemer reports is also kept in Tampermonkey storage (last 1000 lines,
// 30 days) so a run can be reviewed after the tab is closed. Contains revealed keys, like
// the queue does; it never leaves your browser.
const LOG_KEY = 'redeemLog';
const LOG_MAX = 1000;
const LOG_TTL_MS = 30 * 864e5;

function recordLog(msg, now = Date.now()) {
  const list = (GM_getValue(LOG_KEY, []) || []).filter((e) => now - e.t < LOG_TTL_MS);
  list.push({ t: now, m: String(msg) });
  GM_setValue(LOG_KEY, list.slice(-LOG_MAX));
}

// Wraps a panel log so each line is also recorded.
const withRecord = (log) => (msg) => { log(msg); recordLog(msg); };

function logText() {
  return (GM_getValue(LOG_KEY, []) || []).map((e) => new Date(e.t).toLocaleString() + '  ' + e.m).join('\n');
}

function showLogViewer() {
  const ui = makePanel({ width: 620 });
  ui.panel.textContent = '';
  const text = el('textarea', { readonly: 'readonly', style: 'width:100%;height:50vh;background:#111;color:#ddd;border:1px solid #444;font:11px Consolas,monospace;' });
  text.value = logText() || '(empty)';
  const btn = 'margin:6px 6px 0 0;background:#333;color:#eee;border:1px solid #555;border-radius:3px;padding:3px 9px;cursor:pointer;';
  ui.panel.appendChild(el('div', { style: 'font-weight:bold;margin-bottom:4px;' }, 'Redeemer log (last 30 days)'));
  ui.panel.appendChild(text);
  ui.panel.appendChild(el('div', {},
    el('button', { style: btn, onclick: () => { text.select(); navigator.clipboard.writeText(text.value); } }, 'Copy'),
    el('button', { style: btn, onclick: () => ui.remove() }, 'Close')));
  text.scrollTop = text.scrollHeight;
}

const logButton = (style) => el('button', { style: 'background:#333;color:#eee;border:1px solid #555;border-radius:4px;cursor:pointer;' + style, onclick: showLogViewer }, 'Log');

const SHEET_CONFIG = {
  sheetEndpoint: 'Google Apps Script web app URL (ends in /exec):',
  sheetToken: 'Sheet ingest secret token:',
};

// Picks the sheet's region/expiry fields off a key (blank where the store has none).
function sheetFields(item) {
  return {
    onlyInCountries: item.onlyInCountries || '',
    exceptCountries: item.exceptCountries || '',
    expiring: item.expiring || '',
  };
}

// Never throws: these keys are already revealed and the next run skips revealed keys,
// so a failed write must leave them visible in the panel rather than lose them.
async function writeRowsOrPrint(rows, sheetName, log) {
  let result;
  try {
    result = await postRowsToSheet(rows, sheetName);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  log('Sheet write result: ' + JSON.stringify(result));
  if (!result || !result.ok) {
    log('!! SHEET WRITE FAILED - copy these keys manually:');
    rows.forEach((r) => log('   ' + r.title + ' | ' + r.key));
  }
}

async function classifyAppId(appid) {
  const d = await steamAppDetails(appid);
  return d ? { type: d.type || 'unknown', parentAppId: d.fullgame ? Number(d.fullgame.appid) : null } : { type: 'unknown', parentAppId: null };
}

// Reveals item.key in place via the store. Returns true if the item now has a key.
async function revealItem(r, item, log) {
  if (item.key) return true;
  try {
    item.key = await r.reveal(item, log);
  } catch (e) {
    log('  ERROR revealing ' + item.title + ': ' + e.message);
  }
  await sleep(r.revealDelayMs);
  log(item.key ? '  revealed: ' + item.title : '  FAILED to reveal key for ' + item.title + ' - skipping');
  return !!item.key;
}

// Owned-by-appid keys that look like editions ("Complete Edition", "GOTY", "+ Season Pass")
// can include DLC you don't have. If you own all of the base game's DLC the key is a spare;
// otherwise Steam decides: activating grants what's missing, or Steam answers "already owned"
// and the queue files the key as a spare. -> the keys to activate instead of logging.
async function editionsToActivate(ownedItems, owned, log) {
  const out = [];
  for (const k of ownedItems.filter((x) => editionLike(x.title))) {
    const m = await missingDlc(k.appid, owned);
    await sleep(APPDETAILS_DELAY_MS);
    if (!m) continue; // no Steam details: keep it as a spare
    if (m.missing.length) {
      log(k.title + ': you own ' + m.name + ' but not ' + m.missing.length + ' of its ' + m.total + ' DLC, so Steam decides on activation.');
      out.push(k);
    } else if (m.total) {
      log(k.title + ': you own ' + m.name + ' and all ' + m.total + ' of its DLC, so it\'s a spare.');
    }
  }
  return out;
}

async function runScan(store, log) {
  if (!getConfig(SHEET_CONFIG)) {
    log('Missing sheet URL / token - aborting.');
    return;
  }
  const r = store.redeem;

  // Only unrevealed keys: anything already revealed was acted on before (earlier run or by hand),
  // and re-processing it would re-log used keys as tradeable and duplicate sheet rows.
  const listed = await r.listKeys(log);
  const all = listed.filter((k) => !k.key);
  log('Found ' + listed.length + ' Steam key(s); skipping ' + (listed.length - all.length) + ' already revealed. Checking Steam ownership for ' + all.length + '...');
  if (!all.length) {
    log('No unrevealed keys. Done.');
    return;
  }
  const { owned } = await steamUserData();

  // Keys with no appid (some packages) are treated as not owned; if you do own them, Steam
  // says so on activation and the queue files them as spares.
  let ownedItems = all.filter((k) => k.appid && owned.has(k.appid));
  const notOwnedItems = all.filter((k) => !k.appid || !owned.has(k.appid));
  const editions = await editionsToActivate(ownedItems, owned, log);
  ownedItems = ownedItems.filter((k) => !editions.includes(k));
  notOwnedItems.push(...editions);
  log('Already owned: ' + ownedItems.length + '. To activate: ' + notOwnedItems.length + '.');

  if (ownedItems.length) {
    // Owned keys get revealed too: traders want plain Steam keys, not gift links.
    // If a reveal fails, the row is still logged with its unrevealed ref so nothing is lost.
    for (const item of ownedItems) await revealItem(r, item, log);
    log('Writing already-owned keys to the sheet...');
    const rows = ownedItems.map((k) => ({
      title: k.title,
      key: k.key || k.ref,
      status: '', // Status is the sheet's trade column (Traded/Expired), so leave it blank
      ...sheetFields(k),
    }));
    await writeRowsOrPrint(rows, undefined, log);
  }

  if (!notOwnedItems.length) {
    log('Nothing left to activate on Steam. Done.');
    return;
  }

  // No cap: revealed keys wait in the persistent activation queue, which handles Steam's rate limit.
  log('Revealing ' + notOwnedItems.length + ' key(s) on ' + store.name + ' (irreversible)...');
  const revealed = [];
  for (const item of notOwnedItems) {
    if (await revealItem(r, item, log)) revealed.push(item);
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

  // Base games first so DLC finds its base game already activated.
  const added = enqueueKeys([...baseItems, ...dlcItems], store.name);
  if (added) log('Queued ' + added + ' key(s) for activation. ' + (await ensureWorker()));
}

function initStorePage() {
  const store = activeStore('redeem');
  if (!store) return;
  const ui = makePanel({ buttonText: 'Scan & Redeem Keys' });
  const { btn } = ui;
  const log = withRecord(ui.log);
  // A small Log button just left of the Scan button.
  const lb = logButton('position:fixed;top:80px;z-index:999999;padding:10px 12px;font-size:14px;');
  document.body.appendChild(lb);
  lb.style.right = 20 + btn.offsetWidth + 8 + 'px';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    log('--- Scan on ' + store.name + ' (' + location.pathname + ')');
    try {
      await runScan(store, log);
    } catch (e) {
      log('ERROR: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// --- Activation queue ------------------------------------------------------
// Revealed keys wait here (Tampermonkey storage) until Steam's activation page activates them,
// so a rate limit, a closed tab or a sleeping laptop never loses a key.
const QUEUE_KEY = 'activationQueue';
const PAUSE_KEY = 'rateLimitedUntil';
const LOCK_KEY = 'activationLock';
const PING_KEY = 'activationPing'; // store page asks "is a Steam tab working the queue?"
const PONG_KEY = 'activationPong'; // a live Steam tab answers with the same value
const OPENING_KEY = 'activationTabOpening'; // stops two store pages opening two tabs at once
const PING_TIMEOUT_MS = 2000;
const RELOADS_KEY = 'sessionReloads';
const REGISTER_URL = 'https://store.steampowered.com/account/registerkey/';
const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000; // Steam lifts its activation limit about an hour later
const KEY_GAP_MS = 1500;
const MAX_RATE_LIMIT_RETRIES = 4; // a key that keeps getting "rate limited" is reported, not retried forever

// Steam's purchase_result_details codes (as Steam's activation page and FailSpy's redeemer use them).
const ACTIVATION_MESSAGES = {
  9: 'Already owned on this account (key still unused)',
  13: 'Not available in your region',
  14: 'Invalid key',
  15: 'Already activated by another account',
  24: 'Needs the base game first',
  36: 'PlayStation 3 key',
  50: 'Steam wallet / gift card code',
  53: 'Too many recent activation attempts (rate limited)',
};

const getQueue = () => GM_getValue(QUEUE_KEY, []) || [];
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function enqueueKeys(items, store = '') {
  const q = getQueue();
  const known = new Set(q.map((k) => k.key));
  const fresh = items.filter((k) => k.key && !known.has(k.key))
    .map((k) => ({ title: k.title, key: k.key, appid: k.appid || null, type: k.type || 'unknown', store, ...sheetFields(k) }));
  GM_setValue(QUEUE_KEY, q.concat(fresh));
  return fresh.length;
}

// Older versions kept two lists (pendingBase / pendingDlc); fold them into the queue once.
function migratePendingLists() {
  const old = [...(GM_getValue('pendingBase', []) || []), ...(GM_getValue('pendingDlc', []) || [])];
  if (old.length) enqueueKeys(old);
  GM_setValue('pendingBase', []);
  GM_setValue('pendingDlc', []);
  GM_setValue('pendingPhase', null);
}

// Steam's ajaxregisterkey reply -> { code, names }. code 1 = activated. A failure without a
// detail code is treated as a rate limit (as FailSpy's redeemer does), bounded by the retry cap.
function parseActivation(reply) {
  if (reply && reply.success === 1) {
    return { code: 1, names: ((reply.purchase_receipt_info || {}).line_items || []).map((i) => i.line_item_description) };
  }
  const detail = reply && (reply.purchase_result_details || (reply.purchase_receipt_info || {}).result_detail);
  return { code: detail || 53, names: [] };
}

// The same request Steam's own "Activate a Product" page sends; must run on store.steampowered.com.
async function activateKey(key) {
  const sid = (document.cookie.match(/(?:^|; )sessionid=([^;]*)/) || [])[1];
  if (!sid) throw new Error('no Steam session on this page - log in to Steam and reload');
  const res = await fetch('/account/ajaxregisterkey/', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ product_key: key, sessionid: decodeURIComponent(sid) }),
  });
  // A stale login session gets an error page or a non-JSON reply, not a result code.
  const reply = res.ok ? await res.json().catch(() => null) : null;
  if (!reply) throw Object.assign(new Error('Steam rejected the request (HTTP ' + res.status + '): the session looks stale'), { stale: true });
  return parseActivation(reply);
}

// --- Worker tab ---------------------------------------------------------------
// The Steam activation tab that works the queue answers pings through Tampermonkey storage
// (userscripts can't list tabs). No answer means no working tab (closed, frozen or discarded),
// so the store page opens one in the background.
function pingWorker(timeoutMs) {
  return new Promise((resolve) => {
    const nonce = Math.random().toString(36).slice(2);
    let listener = null;
    const done = (alive) => {
      if (listener !== null) GM_removeValueChangeListener(listener);
      listener = null;
      resolve(alive);
    };
    listener = GM_addValueChangeListener(PONG_KEY, (name, oldVal, newVal) => { if (newVal === nonce) done(true); });
    setTimeout(() => done(false), timeoutMs);
    GM_setValue(PING_KEY, nonce);
  });
}

// -> a short status line for the panel
async function ensureWorker(timeoutMs = PING_TIMEOUT_MS) {
  const n = getQueue().length;
  const until = GM_getValue(PAUSE_KEY, 0);
  if (!n) return '';
  if (Date.now() < until) return 'Steam rate limit: ' + n + ' key(s) will activate after ' + fmtTime(until) + '.';
  if (await pingWorker(timeoutMs)) return 'A Steam tab is activating them.';
  if (Date.now() - GM_getValue(OPENING_KEY, 0) < 15000) return 'A Steam tab is opening to activate them.';
  GM_setValue(OPENING_KEY, Date.now());
  GM_openInTab(REGISTER_URL, { active: false, insert: true });
  return 'Opened Steam\'s activation page in a background tab to activate them.';
}

// Refreshing the page renews Steam's login session. Guarded so a real logout can't cause a reload loop.
function reloadForSession(log) {
  const r = GM_getValue(RELOADS_KEY, { n: 0, at: 0 }) || { n: 0, at: 0 };
  const recent = Date.now() - r.at < 10 * 60 * 1000 ? r.n : 0;
  if (recent >= 2) {
    log('Still failing after refreshing: log in to Steam in this browser, then reload this tab. Keys stay queued.');
    return false;
  }
  GM_setValue(RELOADS_KEY, { n: recent + 1, at: Date.now() });
  log('Refreshing this tab to renew the Steam session...');
  location.reload();
  return true;
}

// One tab at a time works the queue (two open Steam tabs would try the same keys).
function takeLock(id) {
  const lock = GM_getValue(LOCK_KEY, null);
  if (lock && lock.id !== id && Date.now() - lock.at < 30000) return false;
  GM_setValue(LOCK_KEY, { id, at: Date.now() });
  return true;
}

let queueRunning = false;
const tabId = Math.random().toString(36).slice(2);

// Works through the queue until it's empty, Steam rate-limits us, or something needs a human.
// Every outcome is persisted per key, so stopping at any point loses nothing.
async function processQueue(log) {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const until = GM_getValue(PAUSE_KEY, 0);
      const q = getQueue();
      if (!q.length) return log('Queue empty: nothing left to activate.');
      if (Date.now() < until) return log('Paused by Steam\'s rate limit: ' + q.length + ' key(s) left, resuming at ' + fmtTime(until) + '. Leave this tab open, or reopen it after that.');
      if (!takeLock(tabId)) return log('Another Steam tab is working through the queue.');

      const item = q[0];
      let result;
      try {
        result = await activateKey(item.key);
      } catch (e) {
        log('Stopped: ' + e.message + ' (' + q.length + ' key(s) still queued).');
        if (e.stale) reloadForSession(log);
        return;
      }
      const rest = getQueue().filter((k) => k.key !== item.key);
      const msg = ACTIVATION_MESSAGES[result.code] || 'Steam error code ' + result.code;

      GM_setValue(RELOADS_KEY, { n: 0, at: 0 }); // the session works
      if (result.code === 1) {
        log('OK    ' + item.title + (result.names.length ? ' (' + result.names.join(', ') + ')' : ''));
        // Every revealed key ends up somewhere in the sheet: activated ones get their own tab.
        await writeRowsOrPrint([{ title: item.title, key: item.key,
          status: 'Activated ' + sheetDate(new Date()) + (item.store ? ' (' + item.store + ')' : ''), ...sheetFields(item) }], ACTIVATED_SHEET, log);
      } else if (result.code === 53 && (item.rateLimited || 0) + 1 < MAX_RATE_LIMIT_RETRIES) {
        GM_setValue(QUEUE_KEY, [{ ...item, rateLimited: (item.rateLimited || 0) + 1 }, ...rest]);
        GM_setValue(PAUSE_KEY, Date.now() + RATE_LIMIT_PAUSE_MS);
        continue; // the pause check at the top logs and stops
      } else if (result.code === 24 && !item.retriedAfterBase) {
        log('LATER ' + item.title + ': ' + msg + '; retrying after the rest of the queue');
        GM_setValue(QUEUE_KEY, [...rest, { ...item, retriedAfterBase: true }]);
        await sleep(KEY_GAP_MS);
        continue;
      } else if (result.code === 9 || result.code === 13) {
        // Unused key you can't use yourself: a tradeable spare for the main sheet tab.
        log('SPARE ' + item.title + ': ' + msg);
        await writeRowsOrPrint([{ title: item.title, key: item.key, status: result.code === 13 ? msg : '', ...sheetFields(item) }], undefined, log);
      } else {
        log('FAIL  ' + item.title + ': ' + msg);
        await writeRowsOrPrint([{ title: item.title, key: item.key, status: 'NOT ACTIVATED: ' + msg, ...sheetFields(item) }], NOT_ACTIVATED_SHEET, log);
      }
      GM_setValue(QUEUE_KEY, rest);
      await sleep(KEY_GAP_MS);
    }
  } finally {
    queueRunning = false;
  }
}

function initRegisterKeyPage() {
  let ui = null;
  const log = withRecord((m) => {
    if (!ui) {
      ui = makePanel({ width: 440 });
      ui.panel.appendChild(el('div', { style: 'text-align:right;' }, logButton('padding:2px 8px;font-size:11px;')));
    }
    ui.log(m);
  });
  // Answer store pages' pings, and take any keys they just queued.
  GM_addValueChangeListener(PING_KEY, (name, oldVal, nonce, remote) => {
    if (!remote) return;
    GM_setValue(PONG_KEY, nonce);
    tick();
  });

  let pausedHere = false;
  // Reads only; nothing is written unless there's work.
  const tick = () => {
    const until = GM_getValue(PAUSE_KEY, 0);
    if (Date.now() < until) { pausedHere = true; return; }
    // Coming out of a rate-limit pause on an hour-old page: refresh first for a fresh session.
    if (pausedHere && getQueue().length) return void location.reload();
    if (getQueue().length && getConfig(SHEET_CONFIG)) processQueue(log);
  };
  if (getQueue().length) log('Activation queue: ' + getQueue().length + ' key(s).');
  GM_setValue(OPENING_KEY, 0);
  tick();
  // A short interval (not one long timer) so it resumes promptly after the laptop sleeps.
  setInterval(tick, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  // Keys queued from a store page start right away.
  GM_addValueChangeListener(QUEUE_KEY, (name, oldVal, newVal, remote) => { if (remote) tick(); });
}

// On store pages: if keys are waiting, make sure a Steam tab is activating them and say so briefly.
async function showQueueNotice() {
  const status = await ensureWorker();
  if (!status) return;
  const ui = makePanel({ top: 140, width: 300 });
  ui.log(getQueue().length + ' key(s) waiting to activate on Steam. ' + status);
  setTimeout(() => ui.remove(), 15000);
}

function runRedeemer() {
  migratePendingLists();
  if (location.hostname === 'store.steampowered.com' && location.pathname.startsWith('/account/registerkey')) {
    initRegisterKeyPage();
  } else {
    initStorePage();
    showQueueNotice();
  }
}
