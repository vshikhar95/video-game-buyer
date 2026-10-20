// Store-agnostic redeem flow: list unrevealed Steam keys from the active store, log owned ones
// to the sheet, reveal the rest and queue them; Steam's activation page then works through the
// queue with the same request Steam's own page uses, pausing for Steam's rate limit.
// Store-specific listing/revealing lives in stores/*.js (the `redeem` capability).

const APPDETAILS_DELAY_MS = 500; // delay between Steam store appdetails calls (rate-limit friendly)
const NOT_ACTIVATED_SHEET = 'Not Activated';

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
  if (!appid) return { type: 'unknown', parentAppId: null };
  try {
    const obj = await gmJson('https://store.steampowered.com/api/appdetails?appids=' + appid);
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

  // Keys with no appid (some packages) land in "not owned"; Steam rejects them if owned
  // and they end up in the Not Activated tab.
  const ownedItems = all.filter((k) => k.appid && owned.has(k.appid));
  const notOwnedItems = all.filter((k) => !k.appid || !owned.has(k.appid));
  log('Already owned: ' + ownedItems.length + '. Not owned: ' + notOwnedItems.length + '.');

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
  const added = enqueueKeys([...baseItems, ...dlcItems]);
  if (added) {
    log('Queued ' + added + ' key(s) for activation. Opening Steam\'s activation page...');
    GM_openInTab('https://store.steampowered.com/account/registerkey/', { active: true });
  }
}

function initStorePage() {
  const store = activeStore('redeem');
  if (!store) return;
  const { btn, log } = makePanel({ buttonText: 'Scan & Redeem Keys' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
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

function enqueueKeys(items) {
  const q = getQueue();
  const known = new Set(q.map((k) => k.key));
  const fresh = items.filter((k) => k.key && !known.has(k.key))
    .map((k) => ({ title: k.title, key: k.key, appid: k.appid || null, type: k.type || 'unknown', ...sheetFields(k) }));
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
  return parseActivation(await res.json().catch(() => null));
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
        return log('Stopped: ' + e.message + ' (' + q.length + ' key(s) still queued).');
      }
      const rest = getQueue().filter((k) => k.key !== item.key);
      const msg = ACTIVATION_MESSAGES[result.code] || 'Steam error code ' + result.code;

      if (result.code === 1) {
        log('OK    ' + item.title + (result.names.length ? ' (' + result.names.join(', ') + ')' : ''));
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
  if (!getQueue().length) return;
  if (!getConfig(SHEET_CONFIG)) return;
  const { log } = makePanel({ width: 440 });
  log('Activation queue: ' + getQueue().length + ' key(s).');
  processQueue(log);
  // Checked on a short interval (not one long timer) so it resumes promptly after the laptop sleeps.
  setInterval(() => processQueue(() => {}), 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) processQueue(log); });
}

// On store pages: show that keys are waiting, with a way to resume.
function showQueueNotice() {
  const q = getQueue();
  if (!q.length) return;
  const until = GM_getValue(PAUSE_KEY, 0);
  const { panel } = makePanel({ top: 140, width: 300 });
  panel.textContent = '';
  panel.appendChild(el('div', {}, q.length + ' key(s) waiting to activate on Steam' +
    (Date.now() < until ? ' (rate limited; resumes at ' + fmtTime(until) + ')' : '') + '. '));
  panel.appendChild(el('button', {
    style: 'margin-top:6px;background:#cb272c;color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;',
    onclick: () => GM_openInTab('https://store.steampowered.com/account/registerkey/', { active: true }),
  }, 'Open Steam'));
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
