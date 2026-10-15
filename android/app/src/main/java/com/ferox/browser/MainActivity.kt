package com.ferox.browser

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var rootLayout: FrameLayout
    private lateinit var webView: WebView
    private lateinit var urlEditText: EditText
    private lateinit var btnShields: LinearLayout
    private lateinit var textShieldsCount: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var btnBack: ImageButton
    private lateinit var btnForward: ImageButton
    private lateinit var btnRefresh: ImageButton
    private lateinit var btnHome: ImageButton
    private lateinit var btnSpeedPill: TextView
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var speedButtonsContainer: LinearLayout
    private lateinit var speedBubble: FrameLayout
    private lateinit var bubbleGlow: View
    private lateinit var bubbleCore: View
    private lateinit var bubbleRipple1: View
    private lateinit var bubbleRipple2: View
    private lateinit var bubbleLabel: TextView
    private lateinit var textSpeedReadout: TextView
    private lateinit var playerContainer: FrameLayout
    private lateinit var miniTouchShield: View
    private lateinit var btnCloseMini: ImageButton

    /** Dedicated WebView for YouTube watch pages. Created lazily. */
    private var playerWebView: WebView? = null
    private var playerExpanded = false
    private var playerMini = false

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    /** Playback state per source WebView ("browse" / "player"). */
    private val playbackStates = mutableMapOf("browse" to false, "player" to false)
    private var playbackServiceStarted = false

    private val shieldsEngine = ShieldsEngine()
    private val speedOptions = arrayOf(
        0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f,
        2.25f, 2.5f, 2.75f, 3.0f, 3.5f, 4.0f
    )
    private var currentSpeed: Float = 1.0f

    // Bubble "tap & hold" tuning state
    private var tuning = false
    private var tuneBaseSpeed = 1.0f
    private var tuneDownRawX = 0f
    private var tuneDownRawY = 0f
    private var tuneStartTx = 0f
    private var tuneStartTy = 0f
    private var lastJsPushTime = 0L

    private var glowAnimator: ObjectAnimator? = null
    private var rippleAnimator1: ObjectAnimator? = null
    private var rippleAnimator2: ObjectAnimator? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        initViews()
        setupSpeedBar()
        setupWebView()
        setupBubble()
        setupListeners()

        // Handle Android Back Navigation: fullscreen -> player -> mini -> web history
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                handleBackNavigation()
            }
        })

        // Initial launch: YouTube
        webView.loadUrl("https://www.youtube.com")
    }

    private fun initViews() {
        rootLayout = findViewById(R.id.rootLayout)
        webView = findViewById(R.id.webView)
        urlEditText = findViewById(R.id.urlEditText)
        btnShields = findViewById(R.id.btnShields)
        textShieldsCount = findViewById(R.id.textShieldsCount)
        progressBar = findViewById(R.id.progressBar)
        btnBack = findViewById(R.id.btnBack)
        btnForward = findViewById(R.id.btnForward)
        btnRefresh = findViewById(R.id.btnRefresh)
        btnHome = findViewById(R.id.btnHome)
        btnSpeedPill = findViewById(R.id.btnSpeedPill)
        fullscreenContainer = findViewById(R.id.fullscreenContainer)
        speedButtonsContainer = findViewById(R.id.speedButtonsContainer)
        speedBubble = findViewById(R.id.speedBubble)
        bubbleGlow = findViewById(R.id.bubbleGlow)
        bubbleCore = findViewById(R.id.bubbleCore)
        bubbleRipple1 = findViewById(R.id.bubbleRipple1)
        bubbleRipple2 = findViewById(R.id.bubbleRipple2)
        bubbleLabel = findViewById(R.id.bubbleLabel)
        textSpeedReadout = findViewById(R.id.textSpeedReadout)
        playerContainer = findViewById(R.id.playerContainer)
        miniTouchShield = findViewById(R.id.miniTouchShield)
        btnCloseMini = findViewById(R.id.btnCloseMini)
    }

    // ==========================================
    // Back navigation: fullscreen -> player -> mini -> history
    // ==========================================
    private fun handleBackNavigation() {
        val player = playerWebView
        if (customView != null) {
            hideFullscreenView()
            return
        }
        if (playerExpanded && player != null) {
            // Back from the full watch page: minimize into the mini player and
            // return to the feed exactly where the user left it.
            if (isYouTubeWatchUrl(player.url)) {
                minimizePlayer()
            } else if (player.canGoBack()) {
                player.goBack()
            } else {
                closePlayer()
            }
            return
        }
        if (playerMini) {
            closePlayer()
            return
        }
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            finish()
        }
    }

    // ==========================================
    // Dedicated player WebView (full + mini player)
    // ==========================================
    @SuppressLint("SetJavaScriptEnabled")
    private fun ensurePlayerWebView(): WebView {
        playerWebView?.let { return it }

        val wv = WebView(this)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = webView.settings.userAgentString
        }
        wv.addJavascriptInterface(FeroxBridge("player"), "FeroxBridge")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                return shieldsEngine.shouldIntercept(request)
                    ?: super.shouldInterceptRequest(view, request)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progressBar.visibility = View.VISIBLE
                if (url != null && !urlEditText.hasFocus()) {
                    urlEditText.setText(url)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
                shieldsEngine.injectCosmeticFilter(wv)
                if (url != null && url.contains("youtube.com", ignoreCase = true)) {
                    YouTubeSpeedEngine.inject(wv)
                    pushSpeedTo(wv, currentSpeed, force = true)
                    if (playerMini) wv.evaluateJavascript(MINI_CSS_JS, null)
                }
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress == 100) progressBar.visibility = View.GONE
            }

            override fun onShowCustomView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
                showFullscreenView(view, callback)
            }

            override fun onHideCustomView() {
                hideFullscreenView()
            }
        }

        playerContainer.addView(
            wv,
            0,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        playerWebView = wv
        return wv
    }

    private fun openPlayerInternal(url: String) {
        val existing = playerWebView
        if (existing != null && existing.url == url && (playerExpanded || playerMini)) {
            if (!playerExpanded) expandPlayer()
            return
        }
        val wv = ensurePlayerWebView()
        wv.loadUrl(url)
        expandPlayer()
    }

    private fun expandPlayer() {
        val lp = playerContainer.layoutParams as FrameLayout.LayoutParams
        lp.width = FrameLayout.LayoutParams.MATCH_PARENT
        lp.height = FrameLayout.LayoutParams.MATCH_PARENT
        lp.gravity = Gravity.TOP or Gravity.START
        lp.setMargins(0, 0, 0, 0)
        playerContainer.layoutParams = lp
        playerContainer.visibility = View.VISIBLE
        miniTouchShield.visibility = View.GONE
        btnCloseMini.visibility = View.GONE
        playerWebView?.evaluateJavascript(EXIT_MINI_CSS_JS, null)
        playerExpanded = true
        playerMini = false
    }

    private fun minimizePlayer() {
        val density = resources.displayMetrics.density
        val lp = playerContainer.layoutParams as FrameLayout.LayoutParams
        lp.width = (208 * density).toInt()
        lp.height = (117 * density).toInt()
        lp.gravity = Gravity.BOTTOM or Gravity.END
        lp.setMargins(0, 0, (8 * density).toInt(), (8 * density).toInt())
        playerContainer.layoutParams = lp
        playerContainer.visibility = View.VISIBLE
        miniTouchShield.visibility = View.VISIBLE
        btnCloseMini.visibility = View.VISIBLE
        playerWebView?.evaluateJavascript(MINI_CSS_JS, null)
        playerExpanded = false
        playerMini = true
    }

    private fun closePlayer() {
        val wv = playerWebView ?: return
        playerContainer.removeView(wv)
        wv.stopLoading()
        wv.destroy()
        playerWebView = null
        playerExpanded = false
        playerMini = false
        playerContainer.visibility = View.GONE
        playbackStates["player"] = false
        updatePlaybackService()
    }

    private fun isYouTubeWatchUrl(url: String?): Boolean {
        if (url.isNullOrEmpty()) return false
        return try {
            val uri = Uri.parse(url)
            val host = uri.host?.lowercase() ?: return false
            val path = uri.path ?: ""
            (host == "youtube.com" || host.endsWith(".youtube.com")) && path == "/watch"
        } catch (e: Exception) {
            false
        }
    }

    // ==========================================
    // Top speed selection bar (compact pills)
    // ==========================================
    private fun setupSpeedBar() {
        speedButtonsContainer.removeAllViews()

        val density = resources.displayMetrics.density
        val heightPx = (24 * density).toInt()
        val padPx = (7 * density).toInt()
        val marginPx = (3 * density).toInt()

        for (spd in speedOptions) {
            val pill = TextView(this).apply {
                text = formatSpeed(spd)
                textSize = 10f
                gravity = Gravity.CENTER
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                setBackgroundResource(R.drawable.bg_speed_btn)
                setPadding(padPx, 0, padPx, 0)
                minWidth = 0
                minimumWidth = 0
                includeFontPadding = false
                isClickable = true
                isFocusable = true
                tag = spd
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    heightPx
                ).apply {
                    marginEnd = marginPx
                }
                setOnClickListener { setPlaybackSpeed(spd) }
            }
            speedButtonsContainer.addView(pill)
        }

        updateSpeedUi(currentSpeed)
    }

    private fun setPlaybackSpeed(speed: Float) {
        currentSpeed = speed
        updateSpeedUi(speed)
        pushSpeedToWeb(speed, force = true)
    }

    private fun updateSpeedUi(speed: Float) {
        btnSpeedPill.text = "⚡ ${formatSpeed(speed)}"
        bubbleLabel.text = formatSpeed(speed)

        // Light up the nearest preset pill (approximate indication for fine tuning)
        var nearest: View? = null
        var bestDiff = Float.MAX_VALUE
        for (i in 0 until speedButtonsContainer.childCount) {
            val child = speedButtonsContainer.getChildAt(i)
            val preset = child.tag as? Float ?: continue
            val diff = abs(preset - speed)
            if (diff < bestDiff) {
                bestDiff = diff
                nearest = child
            }
        }

        for (i in 0 until speedButtonsContainer.childCount) {
            val child = speedButtonsContainer.getChildAt(i) as? TextView ?: continue
            if (child === nearest) {
                child.setBackgroundResource(R.drawable.bg_speed_btn_active)
                child.setTextColor(Color.WHITE)
            } else {
                child.setBackgroundResource(R.drawable.bg_speed_btn)
                child.setTextColor(ContextCompat.getColor(this, R.color.text_secondary))
            }
        }
    }

    // ==========================================
    // Tap-and-hold speed bubble ("globule")
    // ==========================================
    private fun setupBubble() {
        startBubbleAnimations()

        speedBubble.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startTuning(event.rawX, event.rawY)
                    v.parent?.requestDisallowInterceptTouchEvent(true)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (tuning) updateTuning(event.rawX, event.rawY)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    endTuning()
                    v.parent?.requestDisallowInterceptTouchEvent(false)
                    true
                }
                else -> false
            }
        }
    }

    private fun startBubbleAnimations() {
        glowAnimator = ObjectAnimator.ofPropertyValuesHolder(
            bubbleGlow,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 0.92f, 1.22f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 0.92f, 1.22f),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0.6f, 1f)
        ).apply {
            duration = 1100
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }

        rippleAnimator1 = ObjectAnimator.ofPropertyValuesHolder(
            bubbleRipple1,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 0.8f, 1.5f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 0.8f, 1.5f),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0.85f, 0f)
        ).apply {
            duration = 1500
            repeatCount = ValueAnimator.INFINITE
            interpolator = DecelerateInterpolator()
            start()
        }

        rippleAnimator2 = ObjectAnimator.ofPropertyValuesHolder(
            bubbleRipple2,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 0.8f, 1.5f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 0.8f, 1.5f),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0.85f, 0f)
        ).apply {
            duration = 1500
            repeatCount = ValueAnimator.INFINITE
            startDelay = 750
            interpolator = DecelerateInterpolator()
            start()
        }
    }

    private fun startTuning(rawX: Float, rawY: Float) {
        tuning = true
        tuneBaseSpeed = currentSpeed
        tuneDownRawX = rawX
        tuneDownRawY = rawY
        tuneStartTx = speedBubble.translationX
        tuneStartTy = speedBubble.translationY

        speedBubble.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        speedBubble.animate().scaleX(1.08f).scaleY(1.08f).setDuration(120).start()
        bubbleCore.animate().scaleX(1.2f).scaleY(1.2f).setDuration(120).start()

        textSpeedReadout.text = formatSpeed(currentSpeed)
        textSpeedReadout.visibility = View.VISIBLE
        textSpeedReadout.alpha = 0f
        textSpeedReadout.animate().alpha(1f).setDuration(120).start()
    }

    private fun updateTuning(rawX: Float, rawY: Float) {
        val dx = rawX - tuneDownRawX
        val dy = rawY - tuneDownRawY

        // Let the bubble follow the finger anywhere on screen
        val minTx = -speedBubble.left.toFloat()
        val maxTx = (rootLayout.width - speedBubble.width - speedBubble.left).toFloat()
        val minTy = -speedBubble.top.toFloat()
        val maxTy = (rootLayout.height - speedBubble.height - speedBubble.top).toFloat()
        speedBubble.translationX = (tuneStartTx + dx).coerceIn(minTx, maxTx)
        speedBubble.translationY = (tuneStartTy + dy).coerceIn(minTy, maxTy)

        // Horizontal movement tunes speed: right = faster, left = slower (1x - 4x)
        val widthPx = max(resources.displayMetrics.widthPixels.toFloat(), 720f)
        val sensitivity = 3f / (widthPx * 0.5f)
        val next = (tuneBaseSpeed + dx * sensitivity).coerceIn(1f, 4f)
        val rounded = (next * 100f).roundToInt() / 100f

        if (abs(rounded - currentSpeed) > 0.001f) {
            currentSpeed = rounded
            updateSpeedUi(currentSpeed)
            pushSpeedToWeb(currentSpeed)
        }
        textSpeedReadout.text = formatSpeed(currentSpeed)
    }

    private fun endTuning() {
        if (!tuning) return
        tuning = false

        speedBubble.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        speedBubble.animate()
            .translationX(0f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(220)
            .setInterpolator(DecelerateInterpolator())
            .start()
        bubbleCore.animate().scaleX(1f).scaleY(1f).setDuration(160).start()

        textSpeedReadout.animate()
            .alpha(0f)
            .setDuration(180)
            .withEndAction { textSpeedReadout.visibility = View.GONE }
            .start()

        // Guarantee the last fine-tuned value lands on the video
        pushSpeedToWeb(currentSpeed, force = true)
    }

    private fun pushSpeedToWeb(speed: Float, force: Boolean = false) {
        pushSpeedTo(webView, speed, force)
    }

    private fun pushSpeedTo(target: WebView, speed: Float, force: Boolean = false) {
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastJsPushTime < 33L) return
        lastJsPushTime = now

        val value = String.format(Locale.US, "%.2f", speed)
        target.evaluateJavascript("if (window.feroxSetSpeed) window.feroxSetSpeed($value);", null)
    }

    private fun formatSpeed(speed: Float): String {
        val rounded = (speed * 100f).roundToInt() / 100f
        return if (abs(rounded - rounded.toInt()) < 0.001f) {
            "${rounded.toInt()}x"
        } else {
            String.format(Locale.US, "%.2f", rounded).trimEnd('0').trimEnd('.') + "x"
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Ferox/1.0"

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(FeroxBridge("browse"), "FeroxBridge")

        shieldsEngine.setOnBlockedListener { count ->
            runOnUiThread {
                textShieldsCount.text = count.toString()
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                return shieldsEngine.shouldIntercept(request) ?: super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString()
                if (request?.isForMainFrame == true && url != null && isYouTubeWatchUrl(url)) {
                    // Watch pages always open in the dedicated player so the
                    // feed in this WebView is never navigated away from.
                    openPlayerInternal(url)
                    return true
                }
                return false
            }

            @Deprecated("Deprecated in Java")
            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url != null && isYouTubeWatchUrl(url)) {
                    openPlayerInternal(url)
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progressBar.visibility = View.VISIBLE
                if (url != null && !urlEditText.hasFocus()) {
                    urlEditText.setText(url)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
                shieldsEngine.injectCosmeticFilter(webView)
                if (url != null && url.contains("youtube.com", ignoreCase = true)) {
                    YouTubeSpeedEngine.inject(webView)
                    webView.evaluateJavascript(WATCHDOG_JS, null)
                    pushSpeedToWeb(currentSpeed, force = true)
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress == 100) {
                    progressBar.visibility = View.GONE
                }
            }

            override fun onShowCustomView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
                showFullscreenView(view, callback)
            }

            override fun onHideCustomView() {
                hideFullscreenView()
            }
        }
    }

    // ==========================================
    // True fullscreen video
    // ==========================================
    private fun showFullscreenView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
        if (view == null) {
            callback?.onCustomViewHidden()
            return
        }
        if (customView != null) {
            callback?.onCustomViewHidden()
            return
        }
        customView = view
        customViewCallback = callback
        fullscreenContainer.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        fullscreenContainer.visibility = View.VISIBLE
        enterImmersiveMode()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun hideFullscreenView() {
        if (customView == null) return
        fullscreenContainer.removeView(customView)
        fullscreenContainer.visibility = View.GONE
        customViewCallback?.onCustomViewHidden()
        customView = null
        customViewCallback = null
        exitImmersiveMode()
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun enterImmersiveMode() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun exitImmersiveMode() {
        WindowCompat.getInsetsController(window, window.decorView)
            .show(WindowInsetsCompat.Type.systemBars())
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && customView != null) enterImmersiveMode()
    }

    // ==========================================
    // Background playback service + JS bridge
    // ==========================================
    private inner class FeroxBridge(private val source: String) {
        @JavascriptInterface
        fun onPlaybackState(playing: Boolean) {
            runOnUiThread {
                playbackStates[source] = playing
                updatePlaybackService()
            }
        }

        @JavascriptInterface
        fun openPlayer(url: String?) {
            if (url.isNullOrEmpty()) return
            runOnUiThread { openPlayerInternal(url) }
        }
    }

    private fun updatePlaybackService() {
        val playing = playbackStates.values.any { it }
        if (playing) {
            if (!playbackServiceStarted) {
                ensureNotificationPermission()
                ContextCompat.startForegroundService(
                    this,
                    Intent(this, PlaybackService::class.java)
                )
                playbackServiceStarted = true
            }
        } else if (playbackServiceStarted) {
            stopService(Intent(this, PlaybackService::class.java))
            playbackServiceStarted = false
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                1001
            )
        }
    }

    private fun setupListeners() {
        // Omnibox URL load & Search
        urlEditText.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_SEARCH ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER)
            ) {
                val input = urlEditText.text.toString().trim()
                loadUrlOrSearch(input)
                hideKeyboard()
                true
            } else {
                false
            }
        }

        btnBack.setOnClickListener { handleBackNavigation() }
        btnForward.setOnClickListener { if (webView.canGoForward()) webView.goForward() }
        btnRefresh.setOnClickListener {
            val target = if (playerExpanded) playerWebView else webView
            target?.reload()
        }
        btnHome.setOnClickListener { webView.loadUrl("https://search.brave.com") }

        // Mini player interactions
        miniTouchShield.setOnClickListener { expandPlayer() }
        btnCloseMini.setOnClickListener { closePlayer() }

        // Shields Popup
        btnShields.setOnClickListener {
            showShieldsDialog()
        }

        // Top Speed Pill click steps up to the next preset (wraps at 4x)
        btnSpeedPill.setOnClickListener {
            var next = speedOptions[0]
            for (s in speedOptions) {
                if (s > currentSpeed + 0.01f) {
                    next = s
                    break
                }
            }
            setPlaybackSpeed(next)
        }
    }

    private fun loadUrlOrSearch(input: String) {
        if (input.isEmpty()) return
        val url = if (input.startsWith("http://") || input.startsWith("https://")) {
            input
        } else if (input.contains(".") && !input.contains(" ")) {
            "https://$input"
        } else {
            "https://search.brave.com/search?q=" + java.net.URLEncoder.encode(input, "UTF-8")
        }
        if (isYouTubeWatchUrl(url)) {
            openPlayerInternal(url)
        } else {
            // Browsing away from the watch page: keep the video alive as a mini
            // player when possible, otherwise close it.
            if (playerExpanded) {
                if (isYouTubeWatchUrl(playerWebView?.url)) minimizePlayer() else closePlayer()
            }
            webView.loadUrl(url)
        }
    }

    private fun showShieldsDialog() {
        val status = if (shieldsEngine.shieldsEnabled) "Active" else "Disabled"
        MaterialAlertDialogBuilder(this)
            .setTitle("🛡️ Brave Shields Protection")
            .setMessage("Status: $status\n\nBlocked Trackers & Ads: ${shieldsEngine.blockedCount}\n\nFeatures:\n✓ YouTube Video Ads Blocked\n✓ Continuous 1x - 4x Speed Tuning\n✓ Drag-and-Hold Speed Bubble\n✓ Background Audio Playback\n✓ Top Speed Selection Bar\n✓ Mini Player & Fullscreen Video")
            .setPositiveButton(if (shieldsEngine.shieldsEnabled) "Turn Off" else "Turn On") { _, _ ->
                shieldsEngine.shieldsEnabled = !shieldsEngine.shieldsEnabled
                webView.reload()
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(urlEditText.windowToken, 0)
        urlEditText.clearFocus()
    }

    override fun onDestroy() {
        glowAnimator?.cancel()
        rippleAnimator1?.cancel()
        rippleAnimator2?.cancel()
        playerWebView?.let {
            playerContainer.removeView(it)
            it.destroy()
        }
        playerWebView = null
        stopService(Intent(this, PlaybackService::class.java))
        playbackServiceStarted = false
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        /**
         * Watches for YouTube SPA navigations that reach a watch page without
         * a full page load. Those are moved into the dedicated player WebView
         * and the browse WebView returns to the feed (SPA restore, no reload).
         */
        private val WATCHDOG_JS = """
            (function(){
              if (window.__feroxWatchDog) return; window.__feroxWatchDog = true;
              var handled = '';
              setInterval(function(){
                try {
                  var u = new URL(location.href);
                  if (u.pathname === '/watch' && location.href !== handled &&
                      window.FeroxBridge && window.FeroxBridge.openPlayer) {
                    handled = location.href;
                    window.FeroxBridge.openPlayer(location.href);
                    history.back();
                  }
                } catch (e) {}
              }, 400);
            })();
        """.trimIndent()

        /** Hides the YouTube mobile top bar so the video fills the mini player. */
        private val MINI_CSS_JS = """
            (function(){
              var id = 'ferox-mini-css';
              if (!document.getElementById(id)) {
                var s = document.createElement('style');
                s.id = id;
                s.textContent = 'ytm-mobile-topbar-renderer,.mobile-topbar,.ytm-mobile-topbar{display:none !important;} html,body{overflow:hidden !important;}';
                (document.head || document.documentElement).appendChild(s);
              }
              try { window.scrollTo(0, 0); } catch (e) {}
            })();
        """.trimIndent()

        private val EXIT_MINI_CSS_JS = """
            (function(){
              var s = document.getElementById('ferox-mini-css');
              if (s) s.remove();
            })();
        """.trimIndent()
    }
}
