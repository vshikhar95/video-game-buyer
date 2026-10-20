// Store-agnostic redeem flow: list unrevealed Steam keys from the active store, log owned ones
// to the sheet, then activate the rest on Steam (base games first, DLC second).
// Store-specific listing/revealing lives in stores/*.js (the `redeem` capability).

const APPDETAILS_DELAY_MS = 500; // delay between Steam store appdetails calls (rate-limit friendly)
const PHASE_GAP_MS = 8000; // wait between activating base-game batch and DLC batch
// Revealing is irreversible (on Humble it kills the gift link), and Steam rate-limits
// activations (~50/hour). So only reveal this many not-owned keys per run; re-run for the rest.
const MAX_REVEALS_PER_RUN = 40;
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

  const batch = notOwnedItems.slice(0, MAX_REVEALS_PER_RUN);
  if (notOwnedItems.length > batch.length) {
    log('Capping this run at ' + batch.length + ' keys; re-run later for the remaining ' + (notOwnedItems.length - batch.length) + '.');
  }

  log('Revealing ' + batch.length + ' key(s) on ' + store.name + ' (irreversible)...');
  const revealed = [];
  for (const item of batch) {
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

  GM_setValue('pendingBase', baseItems);
  GM_setValue('pendingDlc', dlcItems);
  GM_setValue('pendingPhase', baseItems.length ? 'base' : dlcItems.length ? 'dlc' : null);

  if (baseItems.length || dlcItems.length) {
    log('Opening Steam activation page in a new tab...');
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

// --- Steam registerkey side: auto-continue any pending activation phase ---
async function openActivateMultiple() {
  const link = await waitFor(() => findByText(document, 'a,button,div,span', 'Activate Multiple Products'), 15000);
  if (!link) {
    throw new Error('Could not find "Activate Multiple Products" - is the Augmented Steam extension installed and enabled?');
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

  const submitBtn = await waitFor(() => findByText(document, 'a,button,div,span', 'Activate products'), 5000);
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

  const { log } = makePanel({ width: 420 });
  log('Pending activation phase: ' + phase);
  await sleep(1500); // let the page settle

  // Runs one batch (base or dlc). Never throws: on any error (including the
  // whole activation modal failing to open, e.g. due to a rate limit),
  // every key in this batch is treated as not-activated and reported back
  // so nothing silently disappears.
  async function runBatch(storageKey, label) {
    const items = GM_getValue(storageKey, []);
    if (!items.length) return [];

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
    results.forEach((res) => log((res.ok ? 'OK   ' : 'FAIL ') + res.key + ' - ' + res.message));

    GM_setValue(storageKey, []);
    return results
      .filter((res) => !res.ok)
      .map((res) => {
        const item = byKey[res.key] || {};
        return { title: item.title || '(unknown title)', key: res.key, status: 'NOT ACTIVATED: ' + res.message, ...sheetFields(item) };
      });
  }

  async function saveFailed(failed) {
    if (!failed.length) return;
    log('Saving ' + failed.length + ' not-activated key(s) to the "' + NOT_ACTIVATED_SHEET + '" sheet...');
    await writeRowsOrPrint(failed, NOT_ACTIVATED_SHEET, log);
  }

  if (phase === 'base') {
    await saveFailed(await runBatch('pendingBase', 'base-game'));
    if (GM_getValue('pendingDlc', []).length) {
      GM_setValue('pendingPhase', 'dlc');
      log('Waiting ' + PHASE_GAP_MS / 1000 + 's before activating DLC batch...');
      await sleep(PHASE_GAP_MS);
      await saveFailed(await runBatch('pendingDlc', 'DLC'));
    }
  } else if (phase === 'dlc') {
    await saveFailed(await runBatch('pendingDlc', 'DLC'));
  }
  GM_setValue('pendingPhase', null);
  log('All done.');
}

function runRedeemer() {
  if (location.hostname === 'store.steampowered.com' && location.pathname.startsWith('/account/registerkey')) {
    initRegisterKeyPage();
  } else {
    initStorePage();
  }
}
