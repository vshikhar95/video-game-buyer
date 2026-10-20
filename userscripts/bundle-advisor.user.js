// ==UserScript==
// @name         Bundle Advisor (Steam India prices)
// @namespace    vshikhar95-video-game-buyer
// @version      1.4.2
// @description  On Fanatical and Humble bundle pages, price each game you don't own against its Steam India historical low, and recommend which Fanatical pick & mix picks to take.
// @author       vshikhar95
// @homepageURL  https://github.com/vshikhar95/video-game-buyer
// @updateURL    https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/bundle-advisor.user.js
// @downloadURL  https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/bundle-advisor.user.js
// @match        https://www.fanatical.com/*
// @match        https://www.humblebundle.com/*
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/lib/core.js?v=1.4.2
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/lib/math.js?v=1.4.2
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/lib/advise.js?v=1.4.2
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/stores/humble.js?v=1.4.2
// @require      https://raw.githubusercontent.com/vshikhar95/video-game-buyer/main/userscripts/stores/fanatical.js?v=1.4.2
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.isthereanydeal.com
// @connect      open.er-api.com
// @connect      store.steampowered.com
// @run-at       document-idle
// ==/UserScript==

// All logic lives in the @require files: lib/ is store-agnostic, stores/ has one file per store.
runAdvisor();
