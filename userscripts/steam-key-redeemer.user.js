// ==UserScript==
// @name         IndieGala + Humble + Fanatical -> Steam Key Auto-Redeemer
// @namespace    shikhar-indiegala-steam
// @version      3.2.0
// @description  Reveal your unrevealed Steam keys on Humble, Fanatical or IndieGala, log already-owned ones (with region and expiry) to a Google Sheet, and activate the rest on Steam, base games first, then DLC.
// @author       vshikhar95
// @homepageURL  https://github.com/vshikhar95/video-game-buyer
// @updateURL    https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/steam-key-redeemer.user.js
// @downloadURL  https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/steam-key-redeemer.user.js
// @match        https://www.indiegala.com/*
// @match        https://www.humblebundle.com/*
// @match        https://www.fanatical.com/*
// @match        https://store.steampowered.com/account/registerkey*
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/lib/core.js?v=3.2.0
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/lib/redeem.js?v=3.2.0
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/stores/humble.js?v=3.2.0
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/stores/fanatical.js?v=3.2.0
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/stores/indiegala.js?v=3.2.0
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @connect      store.steampowered.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

// All logic lives in the @require files: lib/ is store-agnostic, stores/ has one file per store.
runRedeemer();
