package com.ferox.browser

import android.webkit.WebView

/**
 * Ferox Shield - document-start engine injected into every page.
 *
 * The ad-blocking strategy follows Brave/uBlock Origin: remove ad payloads
 * from the YouTube player API before the player reads them, hide/remove ad
 * surfaces, close anti-adblock prompts and the mobile "Open in app" dialog,
 * and never "play" an ad. The playback and background-play behaviours are
 * based on Brave's own adblock-resources scriptlets
 * (brave-disable-pageview-api.js, brave-video-bg-play-update.js).
 *
 * This script must be injected at document-start: YouTube captures media and
 * visibility APIs while its scripts load, so late injection cannot work.
 */
object YouTubeSpeedEngine {

    val SPEED_INJECTION_JS = """
        (function () {
          'use strict';
          if (window.__feroxShield) return;
          window.__feroxShield = true;

          var host = location.hostname || '';
          var IS_YT = /(^|\.)youtube\.com$/.test(host) || /(^|\.)youtube-nocookie\.com$/.test(host);
          var IS_MYT = host === 'm.youtube.com';

          function feroxLog(msg) {
            try { if (window.FeroxBridge && window.FeroxBridge.log) window.FeroxBridge.log(msg); } catch (e) {}
          }

          // ---------------------------------------------------------------
          // 1. Brave-style Page Visibility spoof (brave-disable-pageview-api)
          // ---------------------------------------------------------------
          try {
            Object.defineProperty(Document.prototype, 'hidden', {
              get: function () { return false; },
              enumerable: true, configurable: true
            });
            Object.defineProperty(Document.prototype, 'visibilityState', {
              get: function () { return 'visible'; },
              enumerable: true, configurable: true
            });
            Object.defineProperty(Document.prototype, 'onvisibilitychange', {
              get: function () { return null; },
              set: function () {},
              enumerable: true, configurable: true
            });
          } catch (e) {}
          document.addEventListener('visibilitychange', function (e) {
            e.stopImmediatePropagation();
          }, true);

          // ---------------------------------------------------------------
          // 2. Native ad-blocker cosmetic CSS (Brave list filters)
          // ---------------------------------------------------------------
          function injectCosmetics() {
            try {
              if (!window.FeroxBridge || !window.FeroxBridge.getCosmeticCss) return;
              var css = window.FeroxBridge.getCosmeticCss(location.hostname);
              if (!css) return;
              var root = document.head || document.documentElement;
              if (!root) { setTimeout(injectCosmetics, 40); return; }
              if (document.getElementById('ferox-adblock-css')) return;
              var style = document.createElement('style');
              style.id = 'ferox-adblock-css';
              style.textContent = css;
              root.insertBefore(style, root.firstChild);
            } catch (e) {}
          }
          injectCosmetics();

          // ---------------------------------------------------------------
          // 3. Background playback (Brave video-bg-play-update technique)
          // ---------------------------------------------------------------
          var isBackground = false;
          window.feroxSetBackground = function (bg) { isBackground = !!bg; };

          var lastUserInput = 0;
          document.addEventListener('keydown', function () { lastUserInput = Date.now(); }, true);
          document.addEventListener('click', function () { lastUserInput = Date.now(); }, true);
          document.addEventListener('touchstart', function () { lastUserInput = Date.now(); }, true);

          function getVideo() {
            return document.querySelector('#movie_player video, ytd-player video, video.html5-main-video, video');
          }

          document.addEventListener('pause', function (e) {
            if (!isBackground) return;
            if (!e.target || e.target.tagName !== 'VIDEO') return;
            // Brave's rule: a pause within 3s of user input is intentional.
            if (Date.now() - lastUserInput < 3000) return;
            setTimeout(function () {
              var v = getVideo();
              if (v && v.paused && !v.ended && v.readyState >= 2) {
                var p = v.play();
                if (p && p.catch) p.catch(function () {});
              }
            }, 800);
          }, true);

          if (IS_YT) {
            // Keep YouTube's activity clock fresh while backgrounded.
            setInterval(function () { window._lact = Date.now(); }, 5 * 60 * 1000);
          }

          // ---------------------------------------------------------------
          // 4. Real YouTube ad blocking: prune the player API payloads
          //    (uBO/Brave json-prune approach, no fast-forwarding)
          // ---------------------------------------------------------------
          var AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];

          function looksLikePayload(o) {
            if (!o || typeof o !== 'object') return false;
            for (var i = 0; i < AD_KEYS.length; i++) {
              if (AD_KEYS[i] in o) return true;
            }
            return 'playerResponse' in o ||
              (o.auxiliaryUi && o.auxiliaryUi.messageRenderers);
          }

          function prune(root) {
            if (!root || typeof root !== 'object') return;
            var queue = [root];
            var guard = 0;
            while (queue.length && guard++ < 300) {
              var node = queue.pop();
              if (!node || typeof node !== 'object') continue;
              if (Array.isArray(node)) {
                for (var a = 0; a < node.length; a++) queue.push(node[a]);
                continue;
              }
              for (var k = 0; k < AD_KEYS.length; k++) {
                try { delete node[AD_KEYS[k]]; } catch (e) {}
              }
              if (node.playerResponse && typeof node.playerResponse === 'object') {
                queue.push(node.playerResponse);
              }
              if (node.auxiliaryUi && node.auxiliaryUi.messageRenderers) {
                try { delete node.auxiliaryUi.messageRenderers.enforcementMessageViewModel; } catch (e) {}
              }
              if (Array.isArray(node.entries)) {
                for (var j = node.entries.length - 1; j >= 0; j--) {
                  var en = node.entries[j];
                  var adp = en && en.command && en.command.reelWatchEndpoint &&
                    en.command.reelWatchEndpoint.adClientParams;
                  if (adp && adp.isAd) node.entries.splice(j, 1);
                }
              }
              if (Array.isArray(node.messages)) {
                node.messages = node.messages.filter(function (m) {
                  try {
                    return !/ad ?block|adblock|experiencing interruptions/i.test(JSON.stringify(m));
                  } catch (e) { return true; }
                });
              }
            }
          }

          if (IS_YT) {
            try {
              var stored;
              Object.defineProperty(window, 'ytInitialPlayerResponse', {
                configurable: true,
                enumerable: true,
                get: function () { return stored; },
                set: function (v) { try { prune(v); } catch (e) {} stored = v; }
              });
            } catch (e) {}

            var nativeParse = JSON.parse;
            JSON.parse = function (text, reviver) {
              var r = nativeParse.call(this, text, reviver);
              try { if (looksLikePayload(r)) prune(r); } catch (e) {}
              return r;
            };

            var isPlayerUrl = function (u) {
              return typeof u === 'string' && (
                u.indexOf('/youtubei/v1/player') >= 0 ||
                u.indexOf('/youtubei/v1/next') >= 0 ||
                u.indexOf('reel_watch_sequence') >= 0 ||
                u.indexOf('get_watch') >= 0 ||
                u.indexOf('/player?') >= 0
              );
            };

            var nativeFetch = window.fetch;
            if (typeof nativeFetch === 'function') {
              window.fetch = function (input, init) {
                var u = typeof input === 'string' ? input : ((input && input.url) || '');
                var res = nativeFetch.apply(this, arguments);
                if (!isPlayerUrl(u)) return res;
                return res.then(function (response) {
                  try {
                    return response.clone().json().then(function (json) {
                      prune(json);
                      var headers = new Headers(response.headers);
                      headers.delete('content-length');
                      var out = new Response(JSON.stringify(json), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: headers
                      });
                      try { Object.defineProperty(out, 'url', { value: response.url }); } catch (e) {}
                      return out;
                    }).catch(function () { return response; });
                  } catch (e) { return response; }
                });
              };
            }

            try {
              var XHR = window.XMLHttpRequest;
              var nativeOpen = XHR.prototype.open;
              var textDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
              var respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
              XHR.prototype.open = function (method, url) {
                try {
                  if (isPlayerUrl(String(url || ''))) {
                    if (textDesc && textDesc.get) {
                      Object.defineProperty(this, 'responseText', {
                        configurable: true,
                        get: function () {
                          var v = textDesc.get.call(this);
                          try {
                            if (this.readyState === 4 && v) {
                              var d = nativeParse(v);
                              if (looksLikePayload(d)) { prune(d); return JSON.stringify(d); }
                            }
                          } catch (e) {}
                          return v;
                        }
                      });
                    }
                    if (respDesc && respDesc.get) {
                      Object.defineProperty(this, 'response', {
                        configurable: true,
                        get: function () {
                          var v = respDesc.get.call(this);
                          try {
                            if (this.readyState === 4 && v) {
                              if (this.responseType === 'json' && typeof v === 'object') {
                                if (looksLikePayload(v)) prune(v);
                              } else if ((this.responseType === '' || this.responseType === 'text') &&
                                         typeof v === 'string') {
                                var d = nativeParse(v);
                                if (looksLikePayload(d)) { prune(d); return JSON.stringify(d); }
                              }
                            }
                          } catch (e) {}
                          return v;
                        }
                      });
                    }
                  }
                } catch (e) {}
                return nativeOpen.apply(this, arguments);
              };
            } catch (e) {}
          }

          // ---------------------------------------------------------------
          // 5. UI cleanup: ad surfaces, enforcement popup, app prompt
          // ---------------------------------------------------------------
          var AD_SELECTORS = '.ytp-ad-overlay-container,.ytp-ad-player-overlay,' +
            '.ytp-ad-image-overlay,.ytp-ad-text-overlay,.video-ads.ytp-ad-module,' +
            '#player-ads,#masthead-ad,ytd-ad-slot-renderer,ytd-banner-promo-renderer,' +
            'ytd-promoted-sparkles-web-renderer,ytm-promoted-sparkles-web-renderer,' +
            'ytd-in-feed-ad-layout-renderer,ytm-ad-slot-renderer';

          var SKIP_SELECTORS = [
            '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern',
            '.ytp-skip-ad-button', '.ytp-ad-skip-button-text',
            '.videoAdUiSkipButton', 'button[id^="skip-button"]'
          ];

          var lastCleanup = 0;
          function cleanupYouTube() {
            if (!IS_YT) return;
            var now = Date.now();
            if (now - lastCleanup < 250) return;
            lastCleanup = now;
            try {
              document.querySelectorAll(AD_SELECTORS).forEach(function (el) {
                try { el.remove(); } catch (e) {}
              });

              document.querySelectorAll('ytd-enforcement-message-view-model').forEach(function (el) {
                var d = el.closest('tp-yt-paper-dialog') || el;
                d.remove();
                document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach(function (b) { b.remove(); });
                try {
                  document.documentElement.style.overflow = '';
                  if (document.body) document.body.style.overflow = '';
                } catch (e) {}
              });

              document.querySelectorAll('tp-yt-paper-toast').forEach(function (t) {
                if (/experiencing interruptions|ad ?block|blocker/i.test(t.textContent || '')) {
                  t.remove();
                }
              });

              // Only click real skip buttons - never fast-forward the video.
              SKIP_SELECTORS.forEach(function (sel) {
                document.querySelectorAll(sel).forEach(function (btn) {
                  try { if (!btn.disabled) btn.click(); } catch (e) {}
                });
              });

              // Brave's mobile rule: close the "Open in app" prompt.
              if (IS_MYT) {
                document.querySelectorAll('button.yt-spec-button-shape-next[aria-label="Close"][aria-disabled="false"]')
                  .forEach(function (b) { try { b.click(); } catch (e) {} });
              }
            } catch (e) {}
          }
          setInterval(cleanupYouTube, 500);
          try {
            new MutationObserver(cleanupYouTube)
              .observe(document.documentElement || document, { childList: true, subtree: true });
          } catch (e) {}

          // ---------------------------------------------------------------
          // 6. Playback speed control (Ferox feature)
          // ---------------------------------------------------------------
          var preferredSpeed = 1.0;
          try {
            preferredSpeed = parseFloat(
              localStorage.getItem('ferox_speed') || localStorage.getItem('bravest_speed')
            ) || 1.0;
          } catch (e) {}

          function applySpeed(rate) {
            rate = Math.round(Math.min(Math.max(rate, 0.25), 4.0) * 100) / 100;
            preferredSpeed = rate;
            try { localStorage.setItem('ferox_speed', rate.toString()); } catch (e) {}
            try {
              document.querySelectorAll('video').forEach(function (v) {
                try {
                  v.playbackRate = rate;
                  v.defaultPlaybackRate = rate;
                  if ('preservesPitch' in v) v.preservesPitch = true;
                  if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
                } catch (e) {}
              });
            } catch (e) {}
          }

          window.feroxSetSpeed = applySpeed;
          window.feroxGetSpeed = function () { return preferredSpeed; };

          window.feroxUserPause = function () {
            try {
              document.querySelectorAll('video').forEach(function (v) {
                try { v.pause(); } catch (e) {}
              });
            } catch (e) {}
          };

          window.feroxUserPlay = function () {
            try {
              document.querySelectorAll('video').forEach(function (v) {
                try {
                  var p = v.play();
                  if (p && p.catch) p.catch(function () {});
                } catch (e) {}
              });
            } catch (e) {}
          };

          window.feroxGuardPlayback = function (ms) {
            var until = Date.now() + (ms || 2500);
            var wasPlaying = [];
            try {
              document.querySelectorAll('video').forEach(function (v) {
                if (!v.paused && !v.ended) wasPlaying.push(v);
              });
            } catch (e) {}
            var handler = function () {
              if (Date.now() > until) {
                document.removeEventListener('pause', handler, true);
                return;
              }
              setTimeout(function () {
                wasPlaying.forEach(function (v) {
                  try {
                    if (v.paused && !v.ended) {
                      var p = v.play();
                      if (p && p.catch) p.catch(function () {});
                    }
                  } catch (e) {}
                });
              }, 120);
            };
            document.addEventListener('pause', handler, true);
          };

          setInterval(function () {
            try {
              var stored = parseFloat(localStorage.getItem('ferox_speed'));
              if (!isNaN(stored) && Math.abs(stored - preferredSpeed) > 0.001) {
                preferredSpeed = stored;
              }
              document.querySelectorAll('video').forEach(function (v) {
                if (Math.abs(v.playbackRate - preferredSpeed) > 0.05) {
                  try {
                    v.playbackRate = preferredSpeed;
                    v.defaultPlaybackRate = preferredSpeed;
                    if ('preservesPitch' in v) v.preservesPitch = true;
                  } catch (e) {}
                }
              });
            } catch (e) {}
          }, 700);

          // ---------------------------------------------------------------
          // 7. Playback state for the native foreground service
          // ---------------------------------------------------------------
          function reportState() {
            var playing = false;
            try {
              document.querySelectorAll('video').forEach(function (v) {
                if (!v.paused && !v.ended && v.readyState > 0) playing = true;
              });
            } catch (e) {}
            try {
              if (window.FeroxBridge && window.FeroxBridge.onPlaybackState) {
                window.FeroxBridge.onPlaybackState(playing);
              }
            } catch (e) {}
          }
          document.addEventListener('play', reportState, true);
          document.addEventListener('playing', reportState, true);
          document.addEventListener('pause', reportState, true);
          document.addEventListener('ended', reportState, true);
          setInterval(reportState, 3000);
          setTimeout(reportState, 600);

          // ---------------------------------------------------------------
          // 8. Drop late visibility/pagehide subscriptions (Brave technique)
          // ---------------------------------------------------------------
          try {
            var nativeAdd = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type) {
              if (type === 'visibilitychange' || type === 'webkitvisibilitychange' ||
                  type === 'pagehide' || type === 'freeze') {
                return;
              }
              return nativeAdd.apply(this, arguments);
            };
          } catch (e) {}

          setTimeout(function () { applySpeed(preferredSpeed); }, 700);
        })();
    """.trimIndent()

    fun inject(webView: WebView) {
        webView.evaluateJavascript(SPEED_INJECTION_JS, null)
    }
}
