// IndieGala: redeem only, by scraping the library rows on the current page.
(function () {
  const ROW = 'li.profile-private-page-library-subitem';
  const TITLE = '.profile-private-page-library-title-row-full';
  const KEY_INPUT = 'input.profile-private-page-library-key-serial';
  const STEAM_LINK = 'a[href*="store.steampowered.com/app/"]';

  const rows = () => Array.from(document.querySelectorAll(ROW));

  function titleOf(row, appid) {
    const known = row.querySelector(TITLE);
    if (known && known.textContent.trim()) return known.textContent.trim();
    // href looks like https://store.steampowered.com/app/123456/Some_Game_Name/
    const a = row.querySelector(STEAM_LINK);
    const m = a && (a.getAttribute('href') || '').match(/\/app\/\d+\/([^/]+)\/?/);
    if (m) return decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
    return '(unknown title, appid ' + (appid || '?') + ')';
  }

  async function listKeys(log) {
    const all = rows();
    log('Found ' + all.length + ' key row(s) on this page.');
    return all.map((row) => {
      const a = row.querySelector(STEAM_LINK);
      const m = a && (a.getAttribute('href') || '').match(/\/app\/(\d+)/);
      const appid = m ? Number(m[1]) : null;
      const inp = row.querySelector(KEY_INPUT);
      return {
        appid,
        title: titleOf(row, appid),
        key: inp && inp.value && inp.value.trim() ? inp.value.trim() : null,
        ref: '(unrevealed on IndieGala)',
        row,
      };
    });
  }

  async function reveal(item, log) {
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
      const inp = row.querySelector(KEY_INPUT);
      return inp && inp.value && inp.value.trim() ? inp.value.trim() : null;
    }, 20000);
    if (!key) log('  key never appeared after Proceed (timed out)');
    return key;
  }

  registerStore({
    id: 'indiegala',
    name: 'IndieGala',
    redeem: {
      revealDelayMs: 400,
      isActive: () => location.hostname === 'www.indiegala.com' && rows().length > 0,
      listKeys,
      reveal,
    },
  });
})();
