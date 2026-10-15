package com.ferox.browser

import android.webkit.WebView

object YouTubeSpeedEngine {

    val SPEED_INJECTION_JS = """
        (function() {
            if (window.__ferox_mobile_active) return;
            window.__ferox_mobile_active = true;

            console.log('[Ferox Android] YouTube speed, ad-skip & background playback engine loaded');

            let preferredSpeed = parseFloat(localStorage.getItem('ferox_speed') || localStorage.getItem('bravest_speed')) || 1.0;

            // 1. Background Playback Override
            //    YouTube pauses web playback the instant the app leaves the
            //    foreground (a Premium-only feature on the web). This must be
            //    defeated synchronously: the background flag is armed by the
            //    page's own blur/visibility events (registered here at
            //    document-start, before any page script), and programmatic
            //    pause() calls are blocked while it is set. The user can still
            //    pause through the Ferox notification.
            window.__ferox_background = false;
            window.__ferox_allow_pause = false;

            // Capture the real visibility getter before spoofing it, so our
            // own handler can still see the true state.
            var feroxRealVisibilityGetter = null;
            try {
                var feroxVisibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
                if (feroxVisibilityDescriptor && feroxVisibilityDescriptor.get) {
                    feroxRealVisibilityGetter = feroxVisibilityDescriptor.get;
                }
            } catch (_) {}

            try { Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false }); } catch (_) {}
            try { Object.defineProperty(document, 'hidden', { value: false, writable: false }); } catch (_) {}
            try { Object.defineProperty(document, 'webkitVisibilityState', { value: 'visible', writable: false }); } catch (_) {}
            try { Object.defineProperty(document, 'webkitHidden', { value: false, writable: false }); } catch (_) {}
            try { document.hasFocus = function() { return true; }; } catch (_) {}

            var feroxWasPlaying = [];
            var feroxForcePlayUntil = 0;

            function feroxSnapshotPlaying() {
                feroxWasPlaying = [];
                try {
                    document.querySelectorAll('video').forEach(function(v) {
                        if (!v.paused && !v.ended) feroxWasPlaying.push(v);
                    });
                } catch (_) {}
            }

            function feroxResumeIfNeeded() {
                if (!window.__ferox_background) return;
                if (Date.now() > feroxForcePlayUntil) return;
                feroxWasPlaying.forEach(function(v) {
                    try {
                        if (v.paused && !v.ended) {
                            var p = v.play();
                            if (p && typeof p.then === 'function') {
                                p.then(function() {
                                    feroxLog('play() resolved');
                                }).catch(function(e) {
                                    feroxLog('play() rejected: ' + (e && e.name));
                                });
                            }
                        }
                    } catch (_) {}
                });
            }

            function feroxEnterBackground() {
                if (window.__ferox_background) {
                    feroxResumeIfNeeded();
                    return;
                }
                window.__ferox_background = true;
                feroxSnapshotPlaying();
                feroxForcePlayUntil = Date.now() + 15000;
                feroxLog('enterBackground (playing=' + feroxWasPlaying.length + ')');
                feroxResumeIfNeeded();
            }

            function feroxExitBackground() {
                if (!window.__ferox_background) return;
                window.__ferox_background = false;
                feroxForcePlayUntil = 0;
                feroxWasPlaying = [];
                feroxLog('exitBackground');
            }

            // Arm the background flag synchronously with the events the page
            // receives when the app leaves the foreground. These listeners are
            // registered before any page script, so they always run first.
            try {
                document.addEventListener('visibilitychange', function(e) {
                    e.stopImmediatePropagation();
                    var real = 'visible';
                    try {
                        real = feroxRealVisibilityGetter
                            ? feroxRealVisibilityGetter.call(document)
                            : 'visible';
                    } catch (_) {}
                    if (real !== 'visible') feroxEnterBackground();
                    else feroxExitBackground();
                }, true);
            } catch (_) {}
            try { window.addEventListener('blur', feroxEnterBackground, true); } catch (_) {}
            try { window.addEventListener('pagehide', feroxEnterBackground, true); } catch (_) {}
            try { window.addEventListener('focus', feroxExitBackground, true); } catch (_) {}
            try { window.addEventListener('pageshow', feroxExitBackground, true); } catch (_) {}

            // Native confirmation (called from the activity lifecycle).
            window.feroxSetBackground = function(bg) {
                if (bg) feroxEnterBackground();
                else feroxExitBackground();
            };

            // Native-driven resume that does not depend on page timers (which
            // the browser throttles while hidden).
            window.feroxResumeBackground = function() {
                if (!window.__ferox_background) return;
                feroxForcePlayUntil = Math.max(feroxForcePlayUntil, Date.now() + 2000);
                feroxResumeIfNeeded();
            };

            // Block programmatic pauses while the app is backgrounded so the
            // page cannot stop playback. Pauses requested by the user through
            // the Ferox notification set __ferox_allow_pause first.
            function feroxLog(message) {
                try {
                    if (window.FeroxBridge && window.FeroxBridge.log) {
                        window.FeroxBridge.log(message);
                    }
                } catch (_) {}
            }

            try {
                var feroxNativePause = HTMLMediaElement.prototype.pause;
                HTMLMediaElement.prototype.pause = function() {
                    if (window.__ferox_background && !window.__ferox_allow_pause) {
                        feroxLog('blocked pause() call');
                        return;
                    }
                    feroxLog('pause() allowed (bg=' + window.__ferox_background + ')');
                    return feroxNativePause.apply(this, arguments);
                };
            } catch (_) {}

            document.addEventListener('pause', function(e) {
                var v = e.target;
                if (!v || !v.tagName || v.tagName !== 'VIDEO') return;
                var src = '';
                try { src = (v.currentSrc || v.src || '').slice(0, 70); } catch (_) {}
                feroxLog('pause event (bg=' + window.__ferox_background +
                    ') rs=' + v.readyState + ' ns=' + v.networkState +
                    ' ct=' + Math.round(v.currentTime) +
                    ' err=' + (v.error ? v.error.code : 0) +
                    ' src=' + src);
            }, true);
            ['emptied', 'abort', 'loadstart', 'error', 'stalled', 'suspend'].forEach(function(name) {
                document.addEventListener(name, function(e) {
                    var v = e.target;
                    if (!v || !v.tagName || v.tagName !== 'VIDEO') return;
                    feroxLog('media event: ' + name + ' rs=' + v.readyState + ' ns=' + v.networkState);
                }, true);
            });

            window.feroxUserPause = function() {
                window.__ferox_allow_pause = true;
                try {
                    document.querySelectorAll('video').forEach(function(v) {
                        try { v.pause(); } catch (_) {}
                    });
                } catch (_) {}
                setTimeout(function() { window.__ferox_allow_pause = false; }, 600);
            };

            window.feroxUserPlay = function() {
                document.querySelectorAll('video').forEach(function(v) {
                    try {
                        var p = v.play();
                        if (p && typeof p.catch === 'function') p.catch(function() {});
                    } catch (_) {}
                });
            };

            // Keeps playback alive briefly after an in-app transition (e.g.
            // the mini player appearing) even if something pauses the video.
            window.feroxGuardPlayback = function(ms) {
                var until = Date.now() + (ms || 2500);
                var guarded = [];
                document.querySelectorAll('video').forEach(function(v) {
                    if (!v.paused && !v.ended) guarded.push(v);
                });
                var handler = function() {
                    if (Date.now() > until) {
                        document.removeEventListener('pause', handler, true);
                        return;
                    }
                    setTimeout(function() {
                        guarded.forEach(function(v) {
                            try {
                                if (v.paused && !v.ended) {
                                    var p = v.play();
                                    if (p && typeof p.catch === 'function') p.catch(function() {});
                                }
                            } catch (_) {}
                        });
                    }, 120);
                };
                document.addEventListener('pause', handler, true);
            };

            document.addEventListener('pause', function() {
                if (window.__ferox_background) setTimeout(feroxResumeIfNeeded, 150);
            }, true);
            setInterval(feroxResumeIfNeeded, 1000);

            // Drop any later visibility/pagehide/freeze subscriptions (YouTube
            // re-binds handlers on SPA navigation). Registered last so our own
            // listeners above are unaffected.
            try {
                var feroxOriginalAddEventListener = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(type) {
                    if (type === 'visibilitychange' ||
                        type === 'webkitvisibilitychange' ||
                        type === 'pagehide' ||
                        type === 'freeze') {
                        return;
                    }
                    return feroxOriginalAddEventListener.apply(this, arguments);
                };
            } catch (_) {}

            // Report playback state to the native PlaybackService so Android
            // keeps the process alive while audio is playing in the background.
            function reportPlaybackState() {
                var playing = false;
                try {
                    document.querySelectorAll('video').forEach(function(v) {
                        if (!v.paused && !v.ended && v.readyState > 0) playing = true;
                    });
                } catch (_) {}
                try {
                    if (window.FeroxBridge && window.FeroxBridge.onPlaybackState) {
                        window.FeroxBridge.onPlaybackState(playing);
                    }
                } catch (_) {}
            }
            document.addEventListener('play', reportPlaybackState, true);
            document.addEventListener('playing', reportPlaybackState, true);
            document.addEventListener('pause', reportPlaybackState, true);
            document.addEventListener('ended', reportPlaybackState, true);
            setInterval(reportPlaybackState, 3000);
            setTimeout(reportPlaybackState, 800);

            // Block any later visibilitychange subscriptions (YouTube re-binds
            // handlers on SPA navigation).
            try {
                var originalAddEventListener = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(type) {
                    if (type === 'visibilitychange' || type === 'webkitvisibilitychange') return;
                    return originalAddEventListener.apply(this, arguments);
                };
            } catch (_) {}

            // 2. Speed setter used by the native Android controls (pills + bubble)
            window.feroxSetSpeed = function(rate) {
                rate = Math.round(Math.min(Math.max(rate, 0.25), 4.0) * 100) / 100;
                preferredSpeed = rate;
                localStorage.setItem('ferox_speed', rate.toString());

                document.querySelectorAll('video').forEach(function(v) {
                    try {
                        v.playbackRate = rate;
                        v.defaultPlaybackRate = rate;
                        if ('preservesPitch' in v) v.preservesPitch = true;
                        if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
                    } catch (_) {}
                });
            };

            window.feroxGetSpeed = function() {
                return preferredSpeed;
            };

            // 3. Auto Skip Video Ads
            function autoSkipAds() {
                var skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .videoAdUiSkipButton, ytm-ad-slot-renderer');
                if (skipBtn && typeof skipBtn.click === 'function') skipBtn.click();

                var ad = document.querySelector('.ad-showing, .ad-interrupting');
                if (ad) {
                    document.querySelectorAll('video').forEach(function(v) {
                        if (!isNaN(v.duration) && v.duration > 0) v.currentTime = v.duration + 1;
                        v.playbackRate = 16.0;
                    });
                }
            }

            // 4. Enforcer Loop (adopts speed set by the native UI and keeps all videos in sync)
            setInterval(function() {
                autoSkipAds();

                var stored = parseFloat(localStorage.getItem('ferox_speed'));
                if (!isNaN(stored) && Math.abs(stored - preferredSpeed) > 0.001) {
                    preferredSpeed = stored;
                }

                if (preferredSpeed && !document.querySelector('.ad-showing')) {
                    document.querySelectorAll('video').forEach(function(v) {
                        if (Math.abs(v.playbackRate - preferredSpeed) > 0.05) {
                            try {
                                v.playbackRate = preferredSpeed;
                                v.defaultPlaybackRate = preferredSpeed;
                                if ('preservesPitch' in v) v.preservesPitch = true;
                            } catch (_) {}
                        }
                    });
                }
            }, 500);

            // Initial apply
            setTimeout(function() {
                window.feroxSetSpeed(preferredSpeed);
            }, 600);
        })();
    """.trimIndent()

    fun inject(webView: WebView) {
        webView.evaluateJavascript(SPEED_INJECTION_JS, null)
    }
}
