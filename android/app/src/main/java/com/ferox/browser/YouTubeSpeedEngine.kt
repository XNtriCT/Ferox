package com.ferox.browser

import android.webkit.WebView

object YouTubeSpeedEngine {

    val SPEED_INJECTION_JS = """
        (function() {
            if (window.__ferox_mobile_active) return;
            window.__ferox_mobile_active = true;

            console.log('[Ferox Android] YouTube speed, ad-skip & background playback engine loaded');

            let preferredSpeed = parseFloat(localStorage.getItem('ferox_speed') || localStorage.getItem('bravest_speed')) || 1.0;

            // 1. Background Playback Override (Brave feature)
            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
            Object.defineProperty(document, 'hidden', { value: false, writable: false });
            document.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);

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
