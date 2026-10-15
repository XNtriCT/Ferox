package com.ferox.browser

import android.content.Context
import android.util.AttributeSet
import android.util.Log
import android.view.View
import android.webkit.WebView

/**
 * WebView that always reports itself as visible to Chromium.
 *
 * Chromium pauses any media containing a video track when the page is hidden
 * (WebMediaPlayerImpl::ShouldPausePlaybackWhenHidden -> Paused_PageHidden),
 * and the pending play() promise is aborted with AbortError. This happens
 * below JavaScript, so no page-level script can prevent it. The only reliable
 * way to keep video+audio playing while the app is in the background is to
 * never let Chromium learn that the window became invisible.
 */
class AlwaysVisibleWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = android.R.attr.webViewStyle
) : WebView(context, attrs, defStyleAttr) {

    override fun onWindowVisibilityChanged(visibility: Int) {
        Log.i("FeroxPlayback", "onWindowVisibilityChanged($visibility) -> forcing VISIBLE")
        super.onWindowVisibilityChanged(View.VISIBLE)
    }
}
