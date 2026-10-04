package com.ferox.browser

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import java.io.ByteArrayInputStream

class ShieldsEngine {

    var shieldsEnabled: Boolean = true
    var blockedCount: Int = 0
    private var onBlockedListener: ((Int) -> Unit)? = null

    companion object {
        private val AD_HOSTS = listOf(
            "googleads.g.doubleclick.net",
            "pagead2.googlesyndication.com",
            "pubads.g.doubleclick.net",
            "adservice.google.com",
            "static.doubleclick.net",
            "securepubads.g.doubleclick.net",
            "ad.doubleclick.net",
            "google-analytics.com",
            "googletagmanager.com",
            "googlesyndication.com",
            "scorecardresearch.com",
            "criteo.com",
            "taboola.com",
            "outbrain.com",
            "adnxs.com",
            "rubiconproject.com",
            "amazon-adsystem.com",
            "quantserve.com",
            "moatads.com",
            "innovid.com",
            "smartadserver.com",
            "youtube.com/api/stats/ads",
            "youtube.com/pagead",
            "youtube.com/youtubei/v1/player/ad_break",
            "youtube.com/get_midroll_info",
            "youtube.com/ptracking"
        )

        const val COSMETIC_AD_BLOCK_JS = """
            (function() {
                var style = document.getElementById('ferox-adblock-css');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'ferox-adblock-css';
                    style.innerHTML = `
                        .video-ads, .ytp-ad-module, .ytp-ad-overlay-container,
                        .ytp-ad-player-overlay, ytd-ad-slot-renderer,
                        ytd-banner-promo-renderer, ytd-promoted-video-renderer,
                        #masthead-ad, #player-ads, .ytd-in-feed-ad-layout-renderer,
                        ytm-promoted-sparkles-web-renderer, ytm-ad-slot-renderer,
                        ins.adsbygoogle, .adsbygoogle, .ad-container, .taboola, .outbrain {
                            display: none !important;
                            visibility: hidden !important;
                            height: 0 !important;
                            width: 0 !important;
                            pointer-events: none !important;
                        }
                    `;
                    (document.head || document.documentElement).appendChild(style);
                }
            })();
        """
    }

    fun setOnBlockedListener(listener: (Int) -> Unit) {
        this.onBlockedListener = listener
    }

    fun shouldIntercept(request: WebResourceRequest?): WebResourceResponse? {
        if (!shieldsEnabled || request == null) return null

        val url = request.url.toString()
        val isAd = AD_HOSTS.any { host -> url.contains(host, ignoreCase = true) }

        if (isAd) {
            blockedCount++
            onBlockedListener?.invoke(blockedCount)
            // Return empty response (200 OK with empty body) to cancel the ad request
            return WebResourceResponse(
                "text/plain",
                "UTF-8",
                200,
                "OK",
                null,
                ByteArrayInputStream("".toByteArray())
            )
        }

        return null
    }

    fun injectCosmeticFilter(webView: WebView) {
        if (shieldsEnabled) {
            webView.evaluateJavascript(COSMETIC_AD_BLOCK_JS, null)
        }
    }
}
