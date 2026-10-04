package com.ferox.browser

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
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

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

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

        // Handle Android Back Navigation inside WebView
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) {
                    hideFullscreenView()
                } else if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
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
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastJsPushTime < 33L) return
        lastJsPushTime = now

        val value = String.format(Locale.US, "%.2f", speed)
        webView.evaluateJavascript("if (window.feroxSetSpeed) window.feroxSetSpeed($value);", null)
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

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                customView = view
                customViewCallback = callback
                fullscreenContainer.addView(view)
                fullscreenContainer.visibility = View.VISIBLE
                webView.visibility = View.GONE
            }

            override fun onHideCustomView() {
                hideFullscreenView()
            }
        }
    }

    private fun hideFullscreenView() {
        if (customView == null) return
        fullscreenContainer.removeView(customView)
        fullscreenContainer.visibility = View.GONE
        webView.visibility = View.VISIBLE
        customViewCallback?.onCustomViewHidden()
        customView = null
        customViewCallback = null
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

        btnBack.setOnClickListener { if (webView.canGoBack()) webView.goBack() }
        btnForward.setOnClickListener { if (webView.canGoForward()) webView.goForward() }
        btnRefresh.setOnClickListener { webView.reload() }
        btnHome.setOnClickListener { webView.loadUrl("https://search.brave.com") }

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
        webView.loadUrl(url)
    }

    private fun showShieldsDialog() {
        val status = if (shieldsEngine.shieldsEnabled) "Active" else "Disabled"
        MaterialAlertDialogBuilder(this)
            .setTitle("🛡️ Brave Shields Protection")
            .setMessage("Status: $status\n\nBlocked Trackers & Ads: ${shieldsEngine.blockedCount}\n\nFeatures:\n✓ YouTube Video Ads Blocked\n✓ Continuous 1x - 4x Speed Tuning\n✓ Drag-and-Hold Speed Bubble\n✓ Background Audio Playback\n✓ Top Speed Selection Bar")
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
        webView.destroy()
        super.onDestroy()
    }
}
