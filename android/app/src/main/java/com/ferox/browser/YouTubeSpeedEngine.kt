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
            //    YouTube pauses web playback when the page becomes hidden (a
            //    Premium-only feature on the web). Keep the page believing it
            //    is always visible so audio continues in the background.
            try { Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false }); } catch (_) {}
            try { Object.defineProperty(document, 'hidden', { value: false, writable: false }); } catch (_) {}
            try { Object.defineProperty(document, 'webkitVisibilityState', { value: 'visible', writable: false }); } catch (_) {}
            try { Object.defineProperty(document, 'webkitHidden', { value: false, writable: false }); } catch (_) {}
            document.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);
            try { document.hasFocus = function() { return true; }; } catch (_) {}

            // Native tells us when the app goes to / returns from the
            // background. If YouTube force-pauses on hidden, immediately
            // resume the videos that were playing. The short window avoids
            // fighting a deliberate pause from the lock screen later.
            window.__ferox_background = false;
            var feroxWasPlaying = [];
            var feroxForcePlayUntil = 0;

            function feroxResumeIfNeeded() {
                if (!window.__ferox_background) return;
                if (Date.now() > feroxForcePlayUntil) return;
                feroxWasPlaying.forEach(function(v) {
                    try {
                        if (v.paused && !v.ended) {
                            var p = v.play();
                            if (p && typeof p.catch === 'function') p.catch(function() {});
                        }
                    } catch (_) {}
                });
            }

            window.feroxSetBackground = function(bg) {
                window.__ferox_background = !!bg;
                if (bg) {
                    feroxWasPlaying = [];
                    document.querySelectorAll('video').forEach(function(v) {
                        if (!v.paused && !v.ended) feroxWasPlaying.push(v);
                    });
                    feroxForcePlayUntil = Date.now() + 6000;
                    feroxResumeIfNeeded();
                } else {
                    feroxForcePlayUntil = 0;
                    feroxWasPlaying = [];
                }
            };

            document.addEventListener('pause', function() {
                if (window.__ferox_background) setTimeout(feroxResumeIfNeeded, 150);
            }, true);
            setInterval(feroxResumeIfNeeded, 1000);

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
