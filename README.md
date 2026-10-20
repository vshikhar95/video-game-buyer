# video-game-buyer

Personal tools for buying game bundles from India and redeeming the keys.

## Userscripts

Install [Tampermonkey](https://www.tampermonkey.net/), then click the install link. Tampermonkey checks this repo for updates on its own.

| Script | Runs on | Install |
|---|---|---|
| Steam Key Redeemer | Humble Keys page or a bundle's `/downloads?key=` page, Fanatical orders, IndieGala library, Steam's key activation page | [install](https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/steam-key-redeemer.user.js) |

### Steam Key Redeemer

Click **Scan & Redeem Keys** on a supported page. For each Steam key you haven't revealed yet, it:

1. checks whether you already own the game on Steam;
2. owned: reveals the key and logs it (with region and expiry, where the store provides them) to a Google Sheet for trading;
3. not owned: reveals the key and activates it on Steam, base games first, then DLC. Keys that fail to activate are logged to a "Not Activated" tab.

Already-revealed keys and non-Steam keys are skipped.

Needs the [Augmented Steam](https://augmentedsteam.com/) extension (its "Activate Multiple Products" link on Steam's activation page). On first run it asks for a Steam Web API key, your SteamID64, the Google Apps Script web app URL and its ingest token. These are kept in Tampermonkey's storage, not in this repo.

## verdict.py

Compares a bundle's price against Steam India historical lows (via [IsThereAnyDeal](https://isthereanydeal.com/)) and picks the best games for pick-and-mix bundles. Keys go in a local `.env` (see the docstring); `.env` is git-ignored.

## Credits

- Humble API details (order endpoints, `humbler/redeemkey` and its CSRF header) were learned from FailSpy's [humble-steam-key-redeemer](https://github.com/FailSpy/humble-steam-key-redeemer).
- Looking up Fanatical games' Steam IDs through Fanatical's product API follows gbzret4d's [game-store-enhancer](https://github.com/gbzret4d/game-store-enhancer) (MIT).
