/**
 * Ferox Browser - Brave Shields Ad & Tracker Blocker Engine
 *
 * Multi-layer protection:
 *   1. Full Ghostery / uBO / EasyList / EasyPrivacy filter engine, loaded from
 *      prebuilt lists and cached on disk (with a built-in baseline fallback so
 *      blocking never silently disappears when the network is unavailable).
 *   2. Network blocking via a single `onBeforeRequest` listener.  NOTE:
 *      Electron supports only one listener per webRequest event, so this engine
 *      owns the listener.  The previous implementation registered a second one
 *      and it was silently replaced, which disabled most of the blocking.
 *   3. CSP injection via `onHeadersReceived`.
 *   4. Cosmetic filtering (CSS + uBO scriptlets) injected at document-start by
 *      `page_preload.js` (wired in main.js through `will-attach-webview`), plus
 *      dom-ready / SPA-navigation top-ups for pages that load without it.
 *   5. Live per-site blocked counters streamed to the shields UI.
 *
 * No dependency on `session.registerPreloadScript` (Electron >= 35 only), so
 * this works on the Electron 33 runtime this app ships with.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, ipcMain, webContents } = require('electron');
const fetch = require('cross-fetch');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

const BASELINE_FILTERS_PATH = path.join(__dirname, 'baseline_filters.txt');

// Bump whenever baseline_filters.txt or the engine config changes so stale
// caches are rebuilt automatically.
const CACHE_VERSION = 2;

const ENGINE_CONFIG = {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadCSPFilters: true,
  loadExceptionFilters: true,
  loadGenericCosmeticsFilters: true,
  loadExtendedSelectors: false,
  enableMutationObserver: false,
  enableHtmlFiltering: false,
  guessRequestTypeFromUrl: true,
  enableCompression: false
};

// Cosmetic fallback CSS. The filter engine injects far more precise rules; this
// list guarantees the most common ad shells stay hidden even if cosmetic
// injection is delayed or unavailable.
const COSMETIC_AD_BLOCK_CSS = `
  /* YouTube ad elements */
  .video-ads,
  .ytp-ad-module,
  .ytp-ad-overlay-container,
  .ytp-ad-player-overlay,
  .ytp-ad-player-overlay-layout,
  .ytp-ad-image-overlay,
  .ytp-ad-text-overlay,
  .ytp-ad-text,
  .ytp-ad-preview-container,
  .ytp-ad-skip-button-container,
  .ytp-ad-survey,
  .ytp-ad-progress-list,
  .ytp-suggested-action,
  .ytp-featured-product,
  ytd-ad-slot-renderer,
  ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
  ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
  ytd-in-feed-ad-layout-renderer,
  ytd-banner-promo-renderer,
  ytd-banner-promo-renderer-background,
  ytd-promoted-sparkles-web-renderer,
  ytd-promoted-video-renderer,
  ytd-display-ad-renderer,
  ytd-statement-banner-renderer,
  ytd-companion-slot-renderer,
  ytd-action-companion-ad-renderer,
  ytd-player-legacy-desktop-watch-ads-renderer,
  #masthead-ad,
  #player-ads,
  #ad-slot,
  .ytd-merch-shelf-renderer,
  ytd-merch-shelf-renderer,
  ytm-promoted-sparkles-web-renderer,
  ytd-enforcement-message-view-model,
  tp-yt-paper-dialog:has(ytd-enforcement-message-view-model) {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    width: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  /* General web ads */
  ins.adsbygoogle,
  .adsbygoogle,
  [id^="google_ads_"],
  [id^="div-gpt-ad"],
  [id^="aswift_"],
  [data-ad-slot],
  [data-ad-client],
  iframe[src*="doubleclick.net"],
  iframe[src*="googlesyndication.com"],
  iframe[name^="aswift_"],
  .taboola,
  .outbrain {
    display: none !important;
    visibility: hidden !important;
  }
`;

// Resolve a public-suffix-aware domain so cosmetic `domain##rule` filters work.
let tldParse = null;
try {
  tldParse = require('tldts-experimental').parse;
} catch (_) {
  try {
    const adblockerPackage = require.resolve('@ghostery/adblocker-electron/package.json');
    const tldtsPackageDir = path.dirname(
      require.resolve('tldts-experimental', { paths: [path.dirname(adblockerPackage)] })
    );
    tldParse = require(tldtsPackageDir).parse;
  } catch (__) {
    tldParse = null;
  }
}

let baselineFiltersCache = null;
function readBaselineFilters() {
  if (baselineFiltersCache === null) {
    try {
      baselineFiltersCache = fs.readFileSync(BASELINE_FILTERS_PATH, 'utf8');
    } catch (_) {
      baselineFiltersCache = '';
    }
  }
  return baselineFiltersCache;
}

class BraveShieldsEngine {
  constructor() {
    this.engine = null;
    this.session = null;
    this.shieldsEnabled = true;
    this.blockedCount = 0;
    this.siteStats = new Map();
    this.pageUrls = new Map(); // webContents id -> current page url
    this.cosmeticCache = new Map(); // url -> { active, styles, scripts }
    this.preloadInjected = new Set(); // `${wcId}|${url}` already cosmetics-injected
    this.hardCssKeys = new Map(); // webContents id -> insertCSS key
    this.onBlockedCallback = null;
    this.networkAttached = false;
    this.cosmeticIpcRegistered = false;
    this.lastNotifyAt = 0;
    this.notifyTimer = null;
    this.ruleCount = 0;
  }

  /* --------------------------------------------------------------------- *
   * Initialization
   * --------------------------------------------------------------------- */

  async initialize(targetSession, options = {}) {
    console.log('[Ferox Shields] Initializing ad and tracker blocker...');
    this.session = targetSession || null;

    if (options.offline) {
      this.engine = ElectronBlocker.parse(readBaselineFilters(), ENGINE_CONFIG);
    } else {
      this.engine = await this.loadEngine();
    }

    try {
      const filters = this.engine.getFilters();
      this.ruleCount = filters.networkFilters.length + filters.cosmeticFilters.length;
    } catch (_) {
      this.ruleCount = 0;
    }

    if (this.session) this.attachNetworkBlocking(this.session);
    this.registerCosmeticIpc();

    console.log(
      `[Ferox Shields] Engine ready with ${this.ruleCount} filters (+ baseline merge). Network blocking active.`
    );
  }

  async loadEngine() {
    const cachePath = path.join(app.getPath('userData'), `shields-engine-v${CACHE_VERSION}.bin`);

    // 1. Fast path: deserialize the cached engine built by a previous run.
    try {
      const buffer = await fs.promises.readFile(cachePath);
      const engine = ElectronBlocker.deserialize(buffer);
      console.log('[Ferox Shields] Filter engine restored from disk cache.');
      return engine;
    } catch (_) {
      /* cache missing or incompatible - rebuild below */
    }

    // 2. Download the prebuilt lists and merge the built-in baseline on top.
    try {
      const { adsAndTrackingLists, fetchLists, fetchResources } = require('@ghostery/adblocker-electron');
      const lists = await fetchLists(fetch, adsAndTrackingLists);
      const engine = ElectronBlocker.parse(
        lists.join('\n') + '\n' + readBaselineFilters(),
        ENGINE_CONFIG
      );
      try {
        const resources = await fetchResources(fetch);
        if (resources) engine.updateResources(resources, String(resources.length));
      } catch (_) {
        /* scriptlets/resources are optional; network + CSS rules still work */
      }
      fs.promises.writeFile(cachePath, Buffer.from(engine.serialize())).catch(() => {});
      console.log('[Ferox Shields] Fresh filter engine downloaded and compiled.');
      return engine;
    } catch (err) {
      // 3. Last resort: built-in baseline so shields are never fully disabled.
      console.warn(
        `[Ferox Shields] Remote filter lists unavailable (${err.message}). Using built-in baseline filters.`
      );
      return ElectronBlocker.parse(readBaselineFilters(), ENGINE_CONFIG);
    }
  }

  /* --------------------------------------------------------------------- *
   * Network blocking (single listener per webRequest event)
   * --------------------------------------------------------------------- */

  attachNetworkBlocking(targetSession) {
    if (!targetSession || !targetSession.webRequest || this.networkAttached) return;
    this.networkAttached = true;

    targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      this.handleBeforeRequest(details, callback);
    });
    targetSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      this.handleHeadersReceived(details, callback);
    });
    console.log('[Ferox Shields] Native network interceptor active.');
  }

  detachNetworkBlocking() {
    if (!this.session || !this.networkAttached) return;
    // Electron supports a single listener per event; removing ours also clears
    // nothing else because this engine is the only registrar.
    this.session.webRequest.onBeforeRequest(null);
    this.session.webRequest.onHeadersReceived(null);
    this.networkAttached = false;
  }

  handleBeforeRequest(details, callback) {
    if (!this.shieldsEnabled || !this.engine) {
      callback({});
      return;
    }
    try {
      const request = fromElectronDetails(details);
      if (ENGINE_CONFIG.guessRequestTypeFromUrl && request.type === 'other') {
        request.guessTypeOfRequest();
      }
      if (request.isMainFrame()) {
        callback({});
        return;
      }
      const { redirect, match } = this.engine.match(request);
      if (redirect && redirect.dataUrl) {
        this.recordBlocked(details, request);
        callback({ redirectURL: redirect.dataUrl });
        return;
      }
      if (match) {
        this.recordBlocked(details, request);
        callback({ cancel: true });
        return;
      }
    } catch (_) {
      /* never break page loads because of a filter error */
    }
    callback({});
  }

  handleHeadersReceived(details, callback) {
    if (!this.shieldsEnabled || !this.engine) {
      callback({});
      return;
    }
    try {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({});
        return;
      }
      const csp = this.engine.getCSPDirectives(fromElectronDetails(details));
      if (csp !== undefined) {
        const policies = [];
        const responseHeaders = details.responseHeaders || {};
        policies.push(...csp.split(';').map((directive) => directive.trim()));
        for (const [name, values] of Object.entries(responseHeaders)) {
          if (name.toLowerCase() === 'content-security-policy') {
            policies.push(...values);
            delete responseHeaders[name];
          }
        }
        responseHeaders['content-security-policy'] = [policies.join(';')];
        callback({ responseHeaders });
        return;
      }
    } catch (_) {
      /* fall through */
    }
    callback({});
  }

  /* --------------------------------------------------------------------- *
   * Blocked stats
   * --------------------------------------------------------------------- */

  recordBlocked(details, request) {
    this.blockedCount++;

    let siteHost = request.sourceHostname || request.hostname || '';
    const pageUrl = details && details.webContentsId ? this.pageUrls.get(details.webContentsId) : null;
    if (pageUrl) {
      try {
        siteHost = new URL(pageUrl).hostname;
      } catch (_) {}
    }
    if (siteHost) {
      this.siteStats.set(siteHost, (this.siteStats.get(siteHost) || 0) + 1);
    }

    if (this.blockedCount === 1) {
      console.log(`[Ferox Shields] First ad/tracker blocked: ${details.url}`);
    }

    // Throttle IPC traffic so a burst of blocked requests cannot flood the UI.
    const now = Date.now();
    if (now - this.lastNotifyAt > 400) {
      this.lastNotifyAt = now;
      this.emitStats();
    } else if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        this.lastNotifyAt = Date.now();
        this.emitStats();
      }, 500);
    }
  }

  emitStats() {
    if (!this.onBlockedCallback) return;
    try {
      this.onBlockedCallback({ total: this.blockedCount });
    } catch (_) {}
  }

  /* --------------------------------------------------------------------- *
   * Cosmetic filtering
   * --------------------------------------------------------------------- */

  registerCosmeticIpc() {
    if (this.cosmeticIpcRegistered) return;
    this.cosmeticIpcRegistered = true;

    // Document-start request from page_preload.js (synchronous by design).
    ipcMain.on('ferox-shields-cosmetics', (event, payload) => {
      let result = { active: false, styles: '', scripts: [] };
      try {
        result = this.getCosmeticsForUrl(payload && payload.url ? payload.url : '');
      } catch (_) {}
      event.returnValue = result;
    });

    // Confirmation from the preload so the main process does not inject twice.
    ipcMain.on('ferox-shields-injected', (event, payload) => {
      try {
        const sender = event.sender;
        if (sender && !sender.isDestroyed() && payload && payload.url) {
          this.preloadInjected.add(`${sender.id}|${payload.url}`);
          if (this.preloadInjected.size > 2000) this.preloadInjected.clear();
          if (process.env.FEROX_SHIELDS_DEBUG === '1') {
            console.log(`[Ferox Shields] Cosmetics injected at document-start for ${payload.url}`);
          }
        }
      } catch (_) {}
    });
  }

  getCosmeticsForUrl(url) {
    const empty = { active: false, styles: '', scripts: [] };
    if (!this.engine || !this.shieldsEnabled) return empty;
    if (!url || !/^https?:\/\//i.test(url)) return empty;

    const cached = this.cosmeticCache.get(url);
    if (cached) return cached;

    let hostname = '';
    let domain = null;
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      if (tldParse) {
        const tld = tldParse(url, { allowPrivateDomains: true });
        domain = tld.domain || hostname;
      } else {
        const parts = hostname.split('.');
        domain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;
      }
    } catch (_) {
      return empty;
    }

    let message;
    try {
      message = this.engine.getCosmeticsFilters({
        url,
        hostname,
        domain,
        getBaseRules: true,
        getInjectionRules: true,
        getExtendedRules: false,
        getRulesFromHostname: true,
        getRulesFromDOM: false
      });
    } catch (_) {
      return empty;
    }

    // Never inject the raw filter-list scriptlet batch on YouTube: those
    // snippets are not designed to be executed together in one page world
    // (duplicate global bindings / Trusted Types conflicts) and they break
    // YouTube's player boot. Ferox's own document-start YouTube shield in
    // page_preload.js performs the equivalent (and stronger) ad pruning.
    const isYouTubeFamily =
      /(^|\.)youtube\.com$/i.test(hostname) ||
      /(^|\.)youtube-nocookie\.com$/i.test(hostname) ||
      /(^|\.)youtubekids\.com$/i.test(hostname);

    const result = {
      active: message.active !== false,
      styles: message.styles || '',
      scripts: isYouTubeFamily ? [] : Array.isArray(message.scripts) ? message.scripts : []
    };

    if (this.cosmeticCache.size >= 500) this.cosmeticCache.clear();
    this.cosmeticCache.set(url, result);
    return result;
  }

  attachToWebContents(contents) {
    if (!contents) return;

    // Webviews wire their own internal listeners; keep Electron from warning.
    try {
      contents.setMaxListeners(50);
    } catch (_) {}

    const rememberUrl = () => {
      try {
        if (!contents.isDestroyed()) this.pageUrls.set(contents.id, contents.getURL());
      } catch (_) {}
    };

    contents.on('did-navigate', rememberUrl);
    contents.on('did-navigate-in-page', rememberUrl);

    contents.on('dom-ready', () => {
      rememberUrl();
      if (this.shieldsEnabled) this.applyCosmetics(contents);
    });

    contents.on('did-navigate-in-page', () => {
      if (this.shieldsEnabled) this.applyCosmetics(contents);
    });

    contents.on('destroyed', () => {
      this.pageUrls.delete(contents.id);
      this.hardCssKeys.delete(contents.id);
    });
  }

  applyCosmetics(contents) {
    if (!contents || contents.isDestroyed()) return;

    let url = '';
    try {
      url = contents.getURL();
    } catch (_) {
      return;
    }
    if (!url || !/^https?:\/\//i.test(url)) return;

    // 1. Guaranteed fallback CSS (inserted once per webContents).
    if (!this.hardCssKeys.has(contents.id)) {
      try {
        contents
          .insertCSS(COSMETIC_AD_BLOCK_CSS)
          .then((key) => {
            if (key) this.hardCssKeys.set(contents.id, key);
          })
          .catch(() => {});
      } catch (_) {}
    }

    // 2. Engine cosmetics. The preload already handled full page loads at
    //    document-start; only top-up for SPA navigations / late frames.
    if (this.preloadInjected.has(`${contents.id}|${url}`)) return;

    let cosmetics;
    try {
      cosmetics = this.getCosmeticsForUrl(url);
    } catch (_) {
      return;
    }
    if (!cosmetics || cosmetics.active === false) return;

    if (cosmetics.styles) {
      try {
        contents.insertCSS(cosmetics.styles, { cssOrigin: 'user' }).catch(() => {});
      } catch (_) {}
    }
    for (const script of cosmetics.scripts) {
      try {
        contents.executeJavaScript(script, true).catch(() => {});
      } catch (_) {}
    }
  }

  removeCosmetics(contents) {
    if (!contents || contents.isDestroyed()) return;
    try {
      const key = this.hardCssKeys.get(contents.id);
      if (key) {
        contents.removeInsertedCSS(key).catch(() => {});
        this.hardCssKeys.delete(contents.id);
      }
    } catch (_) {}
    try {
      contents
        .executeJavaScript(
          "document.querySelectorAll('style[data-ferox-shields]').forEach(function(e){e.remove();});",
          true
        )
        .catch(() => {});
    } catch (_) {}
  }

  /* --------------------------------------------------------------------- *
   * Shields toggle & stats API
   * --------------------------------------------------------------------- */

  setShieldsEnabled(enabled) {
    enabled = !!enabled;
    if (this.shieldsEnabled === enabled) return;
    this.shieldsEnabled = enabled;
    this.cosmeticCache.clear();

    if (this.session) {
      if (enabled) this.attachNetworkBlocking(this.session);
      else this.detachNetworkBlocking();
    }

    let all = [];
    try {
      all = webContents.getAllWebContents();
    } catch (_) {}
    for (const contents of all) {
      if (!contents || contents.isDestroyed()) continue;
      if (enabled) this.applyCosmetics(contents);
      else this.removeCosmetics(contents);
    }

    console.log(`[Ferox Shields] Shields protection: ${enabled ? 'ON' : 'OFF'}`);
    this.emitStats();
  }

  getBlockedStats() {
    const perSite = {};
    for (const [host, count] of this.siteStats) perSite[host] = count;
    return {
      totalBlocked: this.blockedCount,
      shieldsEnabled: this.shieldsEnabled,
      perSite
    };
  }

  setOnBlockedListener(callback) {
    this.onBlockedCallback = callback;
  }
}

module.exports = BraveShieldsEngine;
