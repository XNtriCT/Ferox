/**
 * Ferox Browser — Brave Shields engine (adblock-rust)
 *
 * Runs the exact engine that powers Brave Shields: `adblock-rust`, Brave's
 * official npm binding (github.com/brave/adblock-rust). Filter lists are
 * loaded from Brave's own list catalog (brave/adblock-resources,
 * filter_lists/list_catalog.json — the same default-enabled desktop set
 * Brave ships) plus Brave's resource library for scriptlet/redirect rules.
 *
 * Layers:
 *   1. Network blocking via a single `onBeforeRequest` listener.
 *      NOTE: Electron supports only one listener per webRequest event, so
 *      this engine owns it.
 *   2. Cosmetic filtering (CSS hide selectors + scriptlet injections)
 *      delivered at document-start to `page_preload.js` over sync IPC, with
 *      dom-ready / SPA-navigation top-ups for frames that miss the preload.
 *   3. Live per-site blocked counters streamed to the shields UI.
 *   4. Serialized engine cache for instant startup; bundled baseline
 *      filters so blocking never silently disappears offline.
 *
 * No dependency on `session.registerPreloadScript` (Electron >= 35 only), so
 * this works on the Electron 33 runtime this app ships with.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, ipcMain, webContents } = require('electron');
const fetch = require('cross-fetch');
const adblockRust = require('adblock-rs');

const BASELINE_FILTERS_PATH = path.join(__dirname, 'baseline_filters.txt');

// Bump whenever the baseline file or engine config changes so stale caches
// are rebuilt automatically.
const CACHE_VERSION = 3;

// Brave's canonical catalog (brave/adblock-resources). On load we enable the
// same default-enabled desktop lists Brave ships.
const CATALOG_URL =
  'https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json';

// Brave's compiled resource library (scriptlet + redirect resources used by
// `##+js()` and `$redirect=` rules).
const RESOURCES_URL =
  'https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json';

// Direct list URLs used when the catalog itself cannot be fetched — the
// exact sources Brave's default desktop catalog resolves to.
const FALLBACK_LIST_URLS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-general.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/ubo-link-shorteners.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-social.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-android-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-sugarcoat.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty-regional.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-cookie-specific.txt',
  'https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt',
  'https://secure.fanboy.co.nz/fanboy-mobile-notifications.txt',
  'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh-online.txt'
];

const DESKTOP_PLATFORMS = new Set(['LINUX', 'WINDOWS', 'MAC']);

// Cosmetic fallback CSS. The engine injects far more precise rules; this
// guarantees the most common ad shells stay hidden even if cosmetic
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

// Electron resourceType -> adblock-rust request type.
const RESOURCE_TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other'
};

function mapResourceType(electronType) {
  return RESOURCE_TYPE_MAP[electronType] || 'other';
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

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
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
    this.resources = null;
  }

  /* --------------------------------------------------------------------- *
   * Initialization
   * --------------------------------------------------------------------- */

  async initialize(targetSession, options = {}) {
    console.log('[Ferox Shields] Initializing Brave adblock-rust engine...');
    this.session = targetSession || null;

    try {
      this.resources = await this.loadResources();
    } catch (err) {
      console.warn(`[Ferox Shields] Resource library unavailable: ${err.message}`);
      this.resources = null;
    }

    if (options.offline) {
      this.engine = this.buildEngine(readBaselineFilters());
    } else {
      this.engine = await this.loadEngine();
    }

    this.applyResources();

    if (this.session) this.attachNetworkBlocking(this.session);
    this.registerCosmeticIpc();

    console.log(
      `[Ferox Shields] Brave engine ready (~${this.ruleCount} rules). Network blocking active.`
    );
  }

  buildEngine(filterText) {
    const set = new adblockRust.FilterSet(false);
    if (filterText) set.addFilters(filterText);
    const engine = new adblockRust.Engine(set);
    this.ruleCount = String(filterText || '')
      .split('\n')
      .filter((line) => line && !line.startsWith('!') && !line.startsWith('[')).length;
    return engine;
  }

  applyResources() {
    if (!this.engine || !Array.isArray(this.resources) || this.resources.length === 0) return;
    try {
      this.engine.useResources(this.resources);
    } catch (err) {
      console.warn(`[Ferox Shields] Resources rejected: ${err.message}`);
    }
  }

  async loadResources() {
    const cachePath = path.join(app.getPath('userData'), `shields-resources-v${CACHE_VERSION}.json`);
    try {
      const raw = await fs.promises.readFile(cachePath, 'utf8');
      const cached = JSON.parse(raw);
      if (Array.isArray(cached) && cached.length > 0) return cached;
    } catch (_) {
      /* stale or missing — refetch */
    }
    const resources = await fetchJson(RESOURCES_URL, 20000);
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new Error('empty resource library');
    }
    fs.promises
      .writeFile(cachePath, JSON.stringify(resources), 'utf8')
      .catch(() => {});
    return resources;
  }

  /** Resolve Brave's default-enabled desktop list sources from the catalog. */
  async resolveListUrls() {
    try {
      const catalog = await fetchJson(CATALOG_URL, 20000);
      const sources = catalog
        .filter((entry) => {
          if (!entry.default_enabled) return false;
          const platforms = entry.platforms || [];
          return platforms.length === 0 || platforms.some((p) => DESKTOP_PLATFORMS.has(p));
        })
        .flatMap((entry) => (entry.sources || []).map((s) => s.url))
        .filter((url) => typeof url === 'string' && url.startsWith('https://'));
      if (sources.length > 0) return sources;
      throw new Error('catalog yielded no sources');
    } catch (err) {
      console.warn(`[Ferox Shields] Catalog unavailable (${err.message}); using pinned Brave lists.`);
      return FALLBACK_LIST_URLS;
    }
  }

  async loadEngine() {
    const cachePath = path.join(app.getPath('userData'), `shields-engine-v${CACHE_VERSION}.bin`);

    // 1. Fast path: deserialize the engine built by a previous run.
    try {
      const buffer = await fs.promises.readFile(cachePath);
      const engine = new adblockRust.Engine(new adblockRust.FilterSet(false));
      engine.deserialize(buffer);
      this.ruleCount = -1;
      console.log('[Ferox Shields] Brave engine restored from disk cache.');
      return engine;
    } catch (_) {
      /* cache missing or incompatible - rebuild below */
    }

    // 2. Download Brave's default lists and compile them into the engine.
    try {
      const urls = await this.resolveListUrls();
      const results = await Promise.allSettled(urls.map((url) => fetchText(url)));
      const texts = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (texts.length === 0) throw new Error('no filter lists could be downloaded');

      const combined = texts.join('\n') + '\n' + readBaselineFilters();
      const engine = this.buildEngine(combined);

      try {
        await fs.promises.writeFile(cachePath, Buffer.from(engine.serialize()));
      } catch (_) {
        /* cache write is best-effort */
      }
      console.log(
        `[Ferox Shields] Compiled ${texts.length}/${urls.length} Brave filter lists into the engine.`
      );
      return engine;
    } catch (err) {
      // 3. Last resort: built-in baseline so shields are never fully disabled.
      console.warn(
        `[Ferox Shields] Remote filter lists unavailable (${err.message}). Using built-in baseline filters.`
      );
      return this.buildEngine(readBaselineFilters());
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
    console.log('[Ferox Shields] Native network interceptor active.');
  }

  detachNetworkBlocking() {
    if (!this.session || !this.networkAttached) return;
    // Electron supports a single listener per event; removing ours also clears
    // nothing else because this engine is the only registrar.
    this.session.webRequest.onBeforeRequest(null);
    this.networkAttached = false;
  }

  handleBeforeRequest(details, callback) {
    if (!this.shieldsEnabled || !this.engine) {
      callback({});
      return;
    }
    try {
      // Top-level navigations are never blocked by the filter engine —
      // same policy as Brave Shields.
      if (details.resourceType === 'mainFrame') {
        callback({});
        return;
      }

      const sourceUrl =
        details.referrer && /^https?:/i.test(details.referrer)
          ? details.referrer
          : details.url;

      const blocked = this.engine.check(
        details.url,
        sourceUrl,
        mapResourceType(details.resourceType),
        details.method ? String(details.method).toLowerCase() : '',
        false
      );

      if (blocked) {
        this.recordBlocked(details, sourceUrl);
        callback({ cancel: true });
        return;
      }
    } catch (_) {
      /* never break page loads because of a filter error */
    }
    callback({});
  }

  /* --------------------------------------------------------------------- *
   * Blocked stats
   * --------------------------------------------------------------------- */

  recordBlocked(details, sourceUrl) {
    this.blockedCount++;

    let siteHost = '';
    try {
      siteHost = new URL(sourceUrl).hostname;
    } catch (_) {
      siteHost = '';
    }
    if (!siteHost && details && details.webContentsId) {
      const pageUrl = this.pageUrls.get(details.webContentsId);
      if (pageUrl) {
        try {
          siteHost = new URL(pageUrl).hostname;
        } catch (_) {}
      }
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
    try {
      hostname = new URL(url).hostname;
    } catch (_) {
      return empty;
    }

    let message;
    try {
      message = this.engine.urlCosmeticResources(url);
    } catch (_) {
      return empty;
    }

    const hide = Array.isArray(message.hide_selectors) ? message.hide_selectors : [];
    const exceptions = Array.isArray(message.exceptions) ? message.exceptions : [];
    const exceptionSet = new Set(exceptions);
    const selectors = hide.filter((selector) => !exceptionSet.has(selector));

    let styles = '';
    if (selectors.length > 0) {
      styles =
        selectors.join(', ') +
        '{display:none !important;visibility:hidden !important;opacity:0 !important;pointer-events:none !important;}';
    }

    // Never inject the raw scriptlet batch on YouTube: those snippets are not
    // designed to be executed together in one page world (duplicate global
    // bindings / Trusted Types conflicts) and they break YouTube's player
    // boot. Ferox's own document-start YouTube shield in page_preload.js
    // performs the equivalent (and stronger) ad pruning.
    const isYouTubeFamily =
      /(^|\.)youtube\.com$/i.test(hostname) ||
      /(^|\.)youtube-nocookie\.com$/i.test(hostname) ||
      /(^|\.)youtubekids\.com$/i.test(hostname);

    const injected =
      typeof message.injected_script === 'string' && message.injected_script.trim()
        ? message.injected_script
        : '';

    const result = {
      active: selectors.length > 0 || (!!injected && !isYouTubeFamily),
      styles,
      scripts: !isYouTubeFamily && injected ? [injected] : []
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
