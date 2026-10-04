/**
 * Ferox Browser - Shields Page Preload
 *
 * Runs at document-start in every webview frame (registered from the main
 * process through `will-attach-webview`). It:
 *
 *   1. Pulls cosmetic filters (CSS + uBO scriptlets) for the current URL from
 *      the main-process ad-blocking engine over synchronous IPC.
 *   2. Injects them before any page script runs, so anti-adblock detection
 *      cannot race ahead of us.
 *   3. Installs a self-contained YouTube shield that prunes ad data from the
 *      player API (ytInitialPlayerResponse, JSON.parse, fetch, XHR) and tears
 *      down YouTube's anti-adblock enforcement pop-up.
 *
 * Sandbox-safe: only `electron` APIs and DOM are used.
 */

'use strict';

const { ipcRenderer } = require('electron');

/* ------------------------------------------------------------------------ *
 * Injection helpers
 * ------------------------------------------------------------------------ */

function whenRootReady(callback) {
  // Electron runs preload scripts before the document element exists, so DOM
  // injections must wait (briefly) for `document.head`/`documentElement`.
  if (document.head || document.documentElement) {
    callback();
    return;
  }
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    if (document.head || document.documentElement || attempts > 2000) {
      clearInterval(timer);
      callback();
    }
  }, 1);
  try {
    document.addEventListener('DOMContentLoaded', () => {
      clearInterval(timer);
      callback();
    }, { once: true });
  } catch (_) {}
}

function runInPage(code) {
  if (!code || typeof code !== 'string') return;

  // 1. Same-world execution. When context isolation is off (Ferox webviews)
  //    the preload shares the page's main world, so a direct eval runs before
  //    any page script. NOTE: Trusted-Types pages (YouTube) reject eval; they
  //    are handled by `installYouTubeShield()` running as a direct call and by
  //    the fallbacks below.
  if (!process.contextIsolated) {
    try {
      (0, eval)(code);
      return;
    } catch (_) {
      /* fall through */
    }
  }

  // 2. Native frame execution. Electron runs this natively in the frame's
  //    world, bypassing page CSP / Trusted Types string-to-code restrictions.
  try {
    const { webFrame } = require('electron');
    const result = webFrame.executeJavaScript(code);
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return;
  } catch (_) {
    /* fall through */
  }

  // 3. TrustedScript policy + script tag (last resort).
  whenRootReady(() => {
    try {
      const root = document.head || document.documentElement;
      if (!root) return;
      let trustedCode = code;
      try {
        const trustedTypesApi = window.trustedTypes;
        if (trustedTypesApi && typeof trustedTypesApi.createPolicy === 'function') {
          let policy = null;
          for (const name of ['ferox-shields', 'default']) {
            try {
              policy = trustedTypesApi.createPolicy(name, { createScript: (value) => value });
              break;
            } catch (_) {}
          }
          if (policy) trustedCode = policy.createScript(code);
        }
      } catch (_) {}
      const script = document.createElement('script');
      script.textContent = trustedCode;
      root.insertBefore(script, root.firstChild);
      script.remove();
    } catch (_) {}
  });
}

function injectStyles(css) {
  if (!css) return;
  whenRootReady(() => {
    try {
      const root = document.head || document.documentElement;
      if (!root) return;
      const style = document.createElement('style');
      style.setAttribute('data-ferox-shields', '1');
      style.textContent = css;
      root.insertBefore(style, root.firstChild);
    } catch (_) {}
  });
}

/* ------------------------------------------------------------------------ *
 * YouTube anti-adblock shield (self-contained, injected at document-start)
 * ------------------------------------------------------------------------ */

function installYouTubeShield() {
  if (window.__feroxYouTubeShield) return;
  try {
    Object.defineProperty(window, '__feroxYouTubeShield', { value: true });
  } catch (_) {
    window.__feroxYouTubeShield = true;
  }

  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];

  function looksLikePlayerPayload(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return (
      AD_KEYS.some((key) => key in obj) ||
      'playerResponse' in obj ||
      (obj.auxiliaryUi && obj.auxiliaryUi.messageRenderers)
    );
  }

  function isAdblockMessage(value) {
    try {
      const text = JSON.stringify(value);
      return /ad ?blocks?|adblock|experiencing interruptions/i.test(text);
    } catch (_) {
      return false;
    }
  }

  function pruneReelEntries(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const params =
        entry &&
        entry.command &&
        entry.command.reelWatchEndpoint &&
        entry.command.reelWatchEndpoint.adClientParams;
      if (params && (params.isAd === true || params.isAd === 'true')) {
        entries.splice(i, 1);
      }
    }
  }

  function prunePlayerPayload(root) {
    try {
      const queue = [root];
      let guard = 0;
      while (queue.length && guard++ < 200) {
        const node = queue.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
          for (const item of node) queue.push(item);
          continue;
        }
        for (const key of AD_KEYS) {
          if (Object.prototype.hasOwnProperty.call(node, key)) {
            try {
              delete node[key];
            } catch (_) {}
          }
        }
        if (node.playerResponse && typeof node.playerResponse === 'object') {
          queue.push(node.playerResponse);
        }
        if (node.auxiliaryUi && node.auxiliaryUi.messageRenderers && typeof node.auxiliaryUi.messageRenderers === 'object') {
          try {
            delete node.auxiliaryUi.messageRenderers.enforcementMessageViewModel;
          } catch (_) {}
        }
        if (Array.isArray(node.messages)) {
          node.messages = node.messages.filter((message) => !isAdblockMessage(message));
        }
        if (Array.isArray(node.entries)) {
          pruneReelEntries(node.entries);
        }
      }
    } catch (_) {}
  }

  // 1. Prune the inline `ytInitialPlayerResponse` before YouTube reads it.
  try {
    let storedResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get() {
        return storedResponse;
      },
      set(value) {
        try {
          prunePlayerPayload(value);
        } catch (_) {}
        storedResponse = value;
      },
    });
  } catch (_) {}

  // 2. Prune every parsed player payload (belt and braces for late parses).
  const nativeParse = JSON.parse;
  JSON.parse = function feroxParse(text, reviver) {
    const result = nativeParse.call(this, text, reviver);
    try {
      if (looksLikePlayerPayload(result)) prunePlayerPayload(result);
    } catch (_) {}
    return result;
  };

  // 3. Prune player API responses fetched with `fetch`.
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function feroxFetch(input, init) {
      const url =
        typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
      const result = nativeFetch.apply(this, arguments);
      if (!/\/youtubei\/v1\/(player|next)|reel_watch_sequence|get_watch|\/player\?/.test(url)) {
        return result;
      }
      return result.then((response) => {
        try {
          return response
            .clone()
            .json()
            .then((json) => {
              prunePlayerPayload(json);
              const headers = new Headers(response.headers);
              headers.delete('content-length');
              const rewritten = new Response(JSON.stringify(json), {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
              try {
                Object.defineProperty(rewritten, 'url', { value: response.url });
              } catch (_) {}
              return rewritten;
            })
            .catch(() => response);
        } catch (_) {
          return response;
        }
      });
    };
  }

  // 4. Prune player API responses fetched with XMLHttpRequest, at read time.
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
      const nativeOpen = XHR.prototype.open;
      const responseTextDescriptor = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
      const responseDescriptor = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

      XHR.prototype.open = function feroxXhrOpen(method, url) {
        try {
          const target = String(url || '');
          if (/\/youtubei\/v1\/(player|next)|reel_watch_sequence|get_watch|\/player\?/.test(target)) {
            if (responseTextDescriptor && responseTextDescriptor.get) {
              Object.defineProperty(this, 'responseText', {
                configurable: true,
                get() {
                  const value = responseTextDescriptor.get.call(this);
                  try {
                    if (this.readyState === 4 && value) {
                      const data = nativeParse(value);
                      if (looksLikePlayerPayload(data)) {
                        prunePlayerPayload(data);
                        return JSON.stringify(data);
                      }
                    }
                  } catch (_) {}
                  return value;
                },
              });
            }
            if (responseDescriptor && responseDescriptor.get) {
              Object.defineProperty(this, 'response', {
                configurable: true,
                get() {
                  const value = responseDescriptor.get.call(this);
                  try {
                    if (this.readyState === 4 && value) {
                      if (this.responseType === 'json' && typeof value === 'object') {
                        if (looksLikePlayerPayload(value)) prunePlayerPayload(value);
                      } else if ((this.responseType === '' || this.responseType === 'text') && typeof value === 'string') {
                        const data = nativeParse(value);
                        if (looksLikePlayerPayload(data)) {
                          prunePlayerPayload(data);
                          return JSON.stringify(data);
                        }
                      }
                    }
                  } catch (_) {}
                  return value;
                },
              });
            }
          }
        } catch (_) {}
        return nativeOpen.apply(this, arguments);
      };
    }
  } catch (_) {}

  // 5. Tear down anti-adblock enforcement pop-ups and resume playback.
  let lastRemoval = 0;

  function resumePlayback() {
    try {
      const video =
        document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (video && video.paused) {
        const playAttempt = video.play();
        if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {});
      }
    } catch (_) {}
  }

  function removeEnforcementElement(element) {
    try {
      const dialog = element.closest('tp-yt-paper-dialog') || element;
      dialog.remove();
      document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((backdrop) => backdrop.remove());
      try {
        document.documentElement.style.overflow = '';
        if (document.body) document.body.style.overflow = '';
      } catch (_) {}
      lastRemoval = Date.now();
      resumePlayback();
    } catch (_) {}
  }

  function killEnforcementPopup() {
    try {
      document
        .querySelectorAll('ytd-enforcement-message-view-model')
        .forEach(removeEnforcementElement);

      document.querySelectorAll('tp-yt-paper-dialog, yt-confirm-dialog-renderer').forEach((dialog) => {
        const text = (dialog.textContent || '').replace(/\s+/g, ' ').trim();
        if (
          text.length < 500 &&
          /ad ?blocks?|adblockers?|experiencing interruptions|violat(e|es|ing).{0,20}(terms|policies)|turn off.{0,20}blocker/i.test(text)
        ) {
          removeEnforcementElement(dialog);
        }
      });

      document.querySelectorAll('tp-yt-paper-toast').forEach((toast) => {
        if (/experiencing interruptions|ad ?blocks?|blocker/i.test(toast.textContent || '')) {
          toast.remove();
        }
      });

      document.querySelectorAll('ytd-enforcement-message-view-model button').forEach((button) => {
        const label = ((button.textContent || '') + ' ' + (button.getAttribute('aria-label') || '')).toLowerCase();
        if (label.includes('dismiss') || label.includes('understand')) {
          try {
            button.click();
          } catch (_) {}
        }
      });

      if (lastRemoval && Date.now() - lastRemoval < 3000) resumePlayback();
    } catch (_) {}
  }

  try {
    let killScheduled = false;
    const scheduleKill = () => {
      if (killScheduled) return;
      killScheduled = true;
      setTimeout(() => {
        killScheduled = false;
        killEnforcementPopup();
      }, 250);
    };
    const start = () => {
      killEnforcementPopup();
      const observer = new MutationObserver(scheduleKill);
      try {
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch (_) {
        observer.observe(document, { childList: true, subtree: true });
      }
      setInterval(killEnforcementPopup, 1000);
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch (_) {}
}

/* ------------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------------ */

const hostname = location.hostname || '';
const isYouTube =
  /(^|\.)youtube\.com$/i.test(hostname) || /(^|\.)youtube-nocookie\.com$/i.test(hostname);

let cosmetics = null;
try {
  cosmetics = ipcRenderer.sendSync('ferox-shields-cosmetics', { url: location.href });
} catch (_) {
  cosmetics = null;
}

if (cosmetics && cosmetics.active !== false) {
  injectStyles(cosmetics.styles);

  if (isYouTube) {
    // Direct call keeps working on Trusted Types pages (YouTube), where
    // string-to-code sinks (`eval`, `script.textContent`) are rejected.
    if (!process.contextIsolated) {
      try {
        installYouTubeShield();
      } catch (_) {
        runInPage('(' + installYouTubeShield.toString() + ')();');
      }
    } else {
      runInPage('(' + installYouTubeShield.toString() + ')();');
    }
  }

  const scripts = Array.isArray(cosmetics.scripts) ? cosmetics.scripts : [];
  for (const code of scripts) {
    // Scope each scriptlet so its top-level bindings (some filter lists declare
    // globals like `const JSONPath`) cannot collide with other scriptlets, and
    // so one failing snippet cannot abort the rest.
    runInPage('try{(function(){' + code + '\n})();}catch(_e){}');
  }

  // Tell the main process this document already received its cosmetics so it
  // does not inject the same styles/scriptlets a second time at dom-ready.
  try {
    ipcRenderer.send('ferox-shields-injected', { url: location.href });
  } catch (_) {}
}
