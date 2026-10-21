# video-game-buyer

Personal tools for buying game bundles from India and redeeming the keys.

## Userscripts

Install [Tampermonkey](https://www.tampermonkey.net/), then click the install link. Tampermonkey checks this repo for updates on its own.

| Script | Runs on | Install |
|---|---|---|
| Bundle Advisor | Fanatical pick & mix and bundle pages, Humble bundle pages | [install](https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/bundle-advisor.user.js) |
| Steam Key Redeemer | Humble Keys page or a bundle's `/downloads?key=` page, Fanatical orders, IndieGala library, Steam's key activation page | [install](https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/steam-key-redeemer.user.js) |

Both use your Steam login in the same browser (store.steampowered.com) to know what you own and have wishlisted.

### Bundle Advisor

Opens a panel on a bundle page that prices every game you don't own against its Steam India historical low (from [IsThereAnyDeal](https://isthereanydeal.com/)), in INR:

- **Fixed bundles:** per tier, the cost per unowned game, and which games have sold for less on Steam India.
- Owned games sold as an edition note how much of the base game's DLC you're missing ("base owned; 4 of 4 DLC not owned").
- **Pick & mix:** the price per pick for taking every unowned pick, and a recommendation that skips picks whose India lows are below the per-pick cost. Filler picks are suggested when a bigger tier is cheaper overall.
- **Fanatical pick & mix cart:** tick picks (or use All / Unowned / Recommended / None), check the live cost, then **Update cart** adds and removes picks in your Fanatical basket to match. Checkout stays manual.

Games are matched to Steam by exact ID where the store or IsThereAnyDeal's bundle data has one, otherwise by name confirmed against the developer/publisher; `~` marks a name-only match and `(?)` an unresolved one. Confident matches are cached for 30 days, so repeat visits skip the lookups; prices and ownership are always fetched fresh.

Prices are converted at the live USD rate plus a 5% card/PayPal markup (change it by adding `"fxMarkup": 0.04` in the script's Storage tab in Tampermonkey). Humble's page prices already include GST for Indian visitors; Fanatical charges none. On first run it asks for an IsThereAnyDeal API key.

### Steam Key Redeemer

Click **Scan & Redeem Keys** on a supported page. For each Steam key you haven't revealed yet, it:

1. checks whether you already own the game on Steam. Edition keys ("Complete Edition", "GOTY", "+ Season Pass"...) for a game you own are checked against the base game's DLC: if you're missing any, the key is activated so Steam grants what's missing (or reports it as owned, making it a spare);
2. owned: reveals the key and logs it (with region and expiry, where the store provides them) to a Google Sheet for trading;
3. not owned: reveals the key and adds it to an **activation queue**, base games first, then DLC. A Steam activation tab that's already open picks the keys up immediately; otherwise one opens in a background tab.

Steam's activation page works through the queue on its own, sending each key the same way Steam's own page does (no extra extension needed):

- activated: written to the sheet's **Activated** tab with the date and store, so every revealed key ends up somewhere in the sheet;
- already owned or not available in your region: the key is still unused, so it goes to the sheet's main tab as a tradeable spare;
- needs the base game: retried once after the rest of the queue;
- invalid or already used: logged to the "Not Activated" tab;
- rate limited by Steam (roughly 50 activations an hour): the queue pauses for an hour, then the tab refreshes itself and carries on, also after the laptop sleeps. If no Steam tab is open by then, the next Humble/Fanatical/IndieGala page you open starts one in the background;
- stale Steam session: the tab refreshes itself (which renews the session) and continues; after two refreshes in ten minutes it stops and asks you to log in.

Keeping a Steam activation tab pinned makes it fully hands-off while the browser runs.

Everything the redeemer reports is also kept in a local log (last 1000 lines, 30 days, in Tampermonkey storage). The **Log** button next to Scan & Redeem Keys, and on the Steam tab's panel, shows it with a Copy button.

Already-revealed keys and non-Steam keys are skipped. On first run it asks for the Google Apps Script web app URL and its ingest token. These are kept in Tampermonkey's storage, not in this repo.

## Code layout

```
userscripts/
  lib/core.js       shared helpers, store registry, panel UI, Steam ownership, Google Sheet
  lib/math.js       pricing math (node userscripts/lib/math.test.js)
  lib/advise.test.js  match cache check (node userscripts/lib/advise.test.js)
  lib/redeem.test.js  activation queue check (node userscripts/lib/redeem.test.js)
  lib/redeem.js     store-agnostic redeem flow
  lib/advise.js     store-agnostic advisor flow
  stores/*.js       one file per store
  *.user.js         thin entry points: header + @require list
  bump.sh           sets a script's @version and its @require ?v= together
```

To add a store: write `stores/<store>.js` calling `registerStore({ id, name, redeem?, advise? })` (the contract is documented at the top of `lib/core.js`), then add its `@match` and `@require` lines to each script that should use it and bump that script's version with `bump.sh`.

## verdict.py

Compares a bundle's price against Steam India historical lows (via [IsThereAnyDeal](https://isthereanydeal.com/)) and picks the best games for pick-and-mix bundles. Keys go in a local `.env` (see the docstring); `.env` is git-ignored.

## Credits

- Humble API details (order endpoints, `humbler/redeemkey` and its CSRF header) were learned from FailSpy's [humble-steam-key-redeemer](https://github.com/FailSpy/humble-steam-key-redeemer).
- Looking up Fanatical games' Steam IDs through Fanatical's product API follows gbzret4d's [game-store-enhancer](https://github.com/gbzret4d/game-store-enhancer) (MIT).
