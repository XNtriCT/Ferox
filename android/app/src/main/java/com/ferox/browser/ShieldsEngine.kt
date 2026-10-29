package com.ferox.browser

import android.content.Context
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Ferox Shields - a real filter-list ad blocker modelled on Brave.
 *
 * Brave's blocker is not a hard-coded domain list: it runs uBlock Origin /
 * EasyList filter syntax over the same subscription lists Brave ships (see
 * brave/adblock-resources/filter_lists/list_catalog.json). This class
 * replicates that pipeline for the Android WebView:
 *
 *  - downloads the default Brave lists (uBO filters + quick fixes, EasyList,
 *    EasyPrivacy, Brave specific/android/first-party/unbreak/social),
 *  - parses network filters into a token-indexed matcher with @@ exceptions,
 *    domain= and first/third-party options, and the caret/star/pipe syntax,
 *  - builds domain cosmetic filter CSS (including generic hiding rules),
 *  - refreshes every five days and falls back to a bundled baseline offline.
 */
class ShieldsEngine(context: Context? = null) {

    var shieldsEnabled: Boolean = true

    private val blockedAtomic = AtomicInteger(0)
    val blockedCount: Int get() = blockedAtomic.get()

    private var onBlockedListener: ((Int) -> Unit)? = null
    private val appContext = context?.applicationContext

    @Volatile private var blockRules: Bucket = Bucket.EMPTY
    @Volatile private var allowRules: Bucket = Bucket.EMPTY
    @Volatile private var cosmetic: CosmeticSet = CosmeticSet.EMPTY
    @Volatile private var currentPageHost: String = ""

    companion object {
        private const val TAG = "FeroxShields"
        private const val REFRESH_MS = 5L * 24 * 60 * 60 * 1000 // 5 days, like Brave

        /**
         * Brave's default-enabled desktop/mobile list catalog sources
         * (brave/adblock-resources filter_lists/list_catalog.json — the same
         * set Brave Shields itself ships, verified against the catalog).
         */
        private val LIST_URLS = listOf(
            // Brave "default" entry
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2020.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2021.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2022.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2023.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2024.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2025.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-general.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/ubo-link-shorteners.txt",
            "https://easylist.to/easylist/easylist.txt",
            "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh-online.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-social.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-android-specific.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-sugarcoat.txt",
            // Brave privacy entry
            "https://easylist.to/easylist/easyprivacy.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
            // Brave first-party entry
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty-regional.txt",
            // Brave cookie annoyances entry
            "https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt",
            "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-cookie-specific.txt",
            // Brave mobile notifications entry
            "https://secure.fanboy.co.nz/fanboy-mobile-notifications.txt"
        )
    }

    init {
        loadBundledBaseline()
        if (appContext != null) {
            thread(name = "ferox-shields-refresh", isDaemon = true) { refreshLists() }
        }
    }

    fun setOnBlockedListener(listener: (Int) -> Unit) {
        this.onBlockedListener = listener
    }

    fun setPageUrl(url: String?) {
        currentPageHost = hostOf(url)
    }

    /* ------------------------------------------------------------------ */
    /* Network blocking                                                    */
    /* ------------------------------------------------------------------ */

    fun shouldIntercept(request: WebResourceRequest?): WebResourceResponse? {
        if (!shieldsEnabled || request == null) return null
        if (request.isForMainFrame) return null

        val uri = request.url ?: return null
        val url = uri.toString()
        val host = uri.host?.lowercase() ?: return null
        if (host.isEmpty()) return null

        val blocked = try {
            val pageHost = currentPageHost
            if (allowRules.anyMatch(url, host, pageHost)) false
            else blockRules.anyMatch(url, host, pageHost)
        } catch (_: Exception) {
            false
        }
        if (!blocked) return null

        val count = blockedAtomic.incrementAndGet()
        onBlockedListener?.invoke(count)
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            200,
            "OK",
            null,
            ByteArrayInputStream(ByteArray(0))
        )
    }

    /* ------------------------------------------------------------------ */
    /* Cosmetic filtering (queried synchronously at document-start)        */
    /* ------------------------------------------------------------------ */

    fun cosmeticCssFor(host: String?): String {
        if (!shieldsEnabled) return ""
        val h = host?.lowercase()?.trim() ?: return ""
        if (h.isEmpty()) return ""
        return cosmetic.cssFor(h)
    }

    fun injectCosmeticFilter(webView: WebView) {
        if (!shieldsEnabled) return
        val css = cosmeticCssFor(webView.url?.let { hostOf(it) })
        if (css.isEmpty()) return
        val js = "(function(){var id='ferox-adblock-css';if(document.getElementById(id))return;" +
            "var s=document.createElement('style');s.id=id;s.textContent=" + jsString(css) +
            ";(document.head||document.documentElement).appendChild(s);})();"
        webView.evaluateJavascript(js, null)
    }

    /* ------------------------------------------------------------------ */
    /* List loading                                                        */
    /* ------------------------------------------------------------------ */

    private fun loadBundledBaseline() {
        val text = try {
            appContext?.assets?.open("baseline_filters.txt")?.bufferedReader()?.use { it.readText() }
                ?: ""
        } catch (_: Exception) {
            ""
        }
        if (text.isEmpty()) return
        val parsed = Parser.parse(text)
        blockRules = parsed.block
        allowRules = parsed.allow
        cosmetic = parsed.cosmetic
    }

    private fun refreshLists() {
        val ctx = appContext ?: return
        val dir = File(ctx.filesDir, "shields").apply { mkdirs() }
        val now = System.currentTimeMillis()
        val merged = StringBuilder(8 * 1024 * 1024)

        for ((index, url) in LIST_URLS.withIndex()) {
            val cache = File(dir, "list_$index.txt")
            val fresh = cache.exists() && now - cache.lastModified() < REFRESH_MS
            try {
                val content = if (fresh) {
                    cache.readText()
                } else {
                    val downloaded = download(url)
                    if (downloaded.isNullOrEmpty()) {
                        if (cache.exists()) cache.readText() else ""
                    } else {
                        cache.writeText(downloaded)
                        cache.setLastModified(now)
                        downloaded
                    }
                }
                if (content.isNotEmpty() && (content.contains("||") || content.contains("##"))) {
                    merged.append(content)
                    if (!merged.endsWith("\n")) merged.append('\n')
                }
            } catch (e: Exception) {
                Log.w(TAG, "List load failed for $url: ${e.message}")
            }
        }

        if (merged.isEmpty()) {
            Log.w(TAG, "No remote lists available; bundled baseline remains active")
            return
        }

        try {
            val parsed = Parser.parse(merged.toString())
            blockRules = parsed.block
            allowRules = parsed.allow
            cosmetic = parsed.cosmetic
            Log.i(
                TAG,
                "Loaded ${parsed.block.size} block + ${parsed.allow.size} allow filters, " +
                    "${parsed.cosmetic.size} cosmetic filters"
            )
        } catch (e: Exception) {
            Log.e(TAG, "Filter parsing failed: ${e.message}")
        }
    }

    private fun download(url: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 45_000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Ferox/1.0 (Android)")
                setRequestProperty("Accept-Encoding", "identity")
            }
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun hostOf(url: String?): String {
        if (url.isNullOrEmpty()) return ""
        return try {
            URL(url).host?.lowercase() ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun jsString(s: String): String {
        val sb = StringBuilder(s.length + 16)
        sb.append('"')
        for (c in s) {
            when (c) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> {}
                '\t' -> sb.append("\\t")
                else -> if (c.code < 32) sb.append("\\u").append(String.format("%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}

/* ====================================================================== */
/* Filter model and matching (file-level so nested classes can share it)   */
/* ====================================================================== */

private class NetFilter(
    val host: String?,          // non-null for ||host^ rules
    val pattern: String,        // remainder after host, or full pattern
    val thirdPartyOnly: Boolean,
    val firstPartyOnly: Boolean,
    val includeDomains: List<String>?,
    val excludeDomains: List<String>?,
    val token: String?
)

private class Bucket(
    val hostRules: HashMap<String, MutableList<NetFilter>>,
    val tokenRules: HashMap<String, MutableList<NetFilter>>,
    val noTokenRules: ArrayList<NetFilter>
) {
    val size: Int
        get() = hostRules.values.sumOf { it.size } +
            tokenRules.values.sumOf { it.size } + noTokenRules.size

    fun add(f: NetFilter) {
        if (f.host != null && f.pattern.isEmpty()) {
            hostRules.getOrPut(f.host) { ArrayList(2) }.add(f)
        } else if (f.token != null) {
            tokenRules.getOrPut(f.token) { ArrayList(2) }.add(f)
        } else {
            noTokenRules.add(f)
        }
    }

    fun anyMatch(url: String, host: String, pageHost: String): Boolean {
        var h = host
        while (true) {
            hostRules[h]?.let { list ->
                for (f in list) if (filterMatches(f, url, host, pageHost)) return true
            }
            val dot = h.indexOf('.')
            if (dot < 0) break
            h = h.substring(dot + 1)
        }

        val lower = url.lowercase()
        var start = 0
        val len = lower.length
        while (start < len) {
            while (start < len && !lower[start].isLetterOrDigit()) start++
            if (start >= len) break
            var end = start + 1
            while (end < len && lower[end].isLetterOrDigit()) end++
            if (end - start >= 4) {
                tokenRules[lower.substring(start, end)]?.let { list ->
                    for (f in list) if (filterMatches(f, lower, host, pageHost)) return true
                }
            }
            start = end
        }

        for (f in noTokenRules) if (filterMatches(f, lower, host, pageHost)) return true
        return false
    }

    companion object {
        val EMPTY: Bucket = Bucket(HashMap(), HashMap(), ArrayList())
    }
}

private class CosmeticSet(
    val domainRules: HashMap<String, MutableList<String>>,
    val genericRules: List<String>,
    val exceptions: HashMap<String, MutableList<String>>
) {
    val size: Int
        get() = domainRules.values.sumOf { it.size } + genericRules.size

    fun cssFor(host: String): String {
        val selectors = LinkedHashSet<String>(Math.max(64, Math.min(1800, genericRules.size + 256)))
        selectors.addAll(genericRules)
        var h = host
        while (true) {
            domainRules[h]?.let { selectors.addAll(it) }
            val dot = h.indexOf('.')
            if (dot < 0) break
            h = h.substring(dot + 1)
            if (selectors.size > 1800) break
        }
        if (selectors.isEmpty()) return ""

        val excluded = HashSet<String>()
        h = host
        while (true) {
            exceptions[h]?.let { excluded.addAll(it) }
            val dot = h.indexOf('.')
            if (dot < 0) break
            h = h.substring(dot + 1)
        }

        val sb = StringBuilder(selectors.size * 28)
        for (sel in selectors) {
            if (excluded.contains(sel)) continue
            sb.append(sel).append(" { display: none !important; }\n")
        }
        return sb.toString()
    }

    companion object {
        val EMPTY: CosmeticSet = CosmeticSet(HashMap(), emptyList(), HashMap())
    }
}

private class Parsed(val block: Bucket, val allow: Bucket, val cosmetic: CosmeticSet)

private object Parser {

    fun parse(text: String): Parsed {
        val block = Bucket(HashMap(), HashMap(), ArrayList())
        val allow = Bucket(HashMap(), HashMap(), ArrayList())

        val cssDomain = HashMap<String, MutableList<String>>(4096)
        val cssGeneric = ArrayList<String>(1024)
        val cssExceptions = HashMap<String, MutableList<String>>(1024)
        val seenCss = HashSet<String>(16384)
        val seenNet = HashSet<String>(65536)

        for (raw in text.lineSequence()) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("!") || line.startsWith("[")) continue

            if (line.contains("##") || line.contains("#@#") || line.contains("#?#")) {
                parseCosmetic(line, cssDomain, cssGeneric, cssExceptions, seenCss)
                continue
            }

            var exception = false
            var body = line
            if (body.startsWith("@@")) {
                exception = true
                body = body.substring(2)
            }
            if (body.isEmpty()) continue
            if (body.startsWith("/") && body.endsWith("/")) continue
            if (!seenNet.add((if (exception) "@@" else "") + body)) continue

            val f = parseNetwork(body) ?: continue
            if (exception) allow.add(f) else block.add(f)
        }

        return Parsed(block, allow, CosmeticSet(cssDomain, cssGeneric, cssExceptions))
    }

    private fun parseNetwork(line: String): NetFilter? {
        var pattern = line
        var thirdParty = false
        var firstParty = false
        var includeDomains: List<String>? = null
        var excludeDomains: List<String>? = null

        val dollar = pattern.indexOf('$')
        if (dollar >= 0) {
            val options = pattern.substring(dollar + 1).split(',')
            pattern = pattern.substring(0, dollar)
            for (opt in options) {
                val o = opt.trim().lowercase()
                when {
                    o == "third-party" || o == "3p" -> thirdParty = true
                    o == "first-party" || o == "1p" -> firstParty = true
                    o.startsWith("domain=") -> {
                        val inc = ArrayList<String>()
                        val exc = ArrayList<String>()
                        for (d in o.removePrefix("domain=").split('|')) {
                            if (d.startsWith("~")) {
                                if (d.length > 1) exc.add(d.substring(1))
                            } else if (d.isNotEmpty()) {
                                inc.add(d)
                            }
                        }
                        if (inc.isNotEmpty()) includeDomains = inc
                        if (exc.isNotEmpty()) excludeDomains = exc
                    }
                    o.contains("generichide") || o.contains("elemhide") ||
                        o.contains("specifichide") || o.contains("ghide") ||
                        o.contains("ehide") || o.contains("shide") -> return null
                    o.contains("document") || o == "doc" -> return null
                    o.contains("removeparam") || o.contains("replace=") ||
                        o.contains("csp=") || o.contains("permissions=") -> return null
                    o.contains("badfilter") -> return null
                    o.startsWith("redirect") -> return null
                    o == "popup" -> return null
                }
            }
        }
        if (pattern.isEmpty()) return null

        var host: String? = null
        var rest = pattern
        if (pattern.startsWith("||")) {
            rest = pattern.substring(2)
            var end = rest.length
            for (i in rest.indices) {
                val c = rest[i]
                if (c == '^' || c == '/' || c == '*') {
                    end = i
                    break
                }
            }
            val hostPart = rest.substring(0, end).trim('.', ' ')
            if (hostPart.isEmpty()) return null
            host = hostPart.lowercase()
            rest = rest.substring(end)
            if (rest == "^") rest = ""
        }

        return NetFilter(
            host = host,
            pattern = rest.lowercase(),
            thirdPartyOnly = thirdParty,
            firstPartyOnly = firstParty,
            includeDomains = includeDomains,
            excludeDomains = excludeDomains,
            token = firstToken(rest)
        )
    }

    private fun parseCosmetic(
        line: String,
        cssDomain: HashMap<String, MutableList<String>>,
        cssGeneric: ArrayList<String>,
        cssExceptions: HashMap<String, MutableList<String>>,
        seen: HashSet<String>
    ) {
        if (line.contains("+js(")) return
        if (line.contains("#?#")) return
        if (line.contains(":style(") || line.contains(":remove()") ||
            line.contains(":has-text(") || line.contains(":matches-") ||
            line.contains(":xpath(") || line.contains(":upward(") ||
            line.contains(":nth-ancestor(") || line.contains(":watch-attr(") ||
            line.contains(":min-text-length") || line.contains(":others(")) {
            return
        }

        val marker = if (line.contains("#@#")) "#@#" else "##"
        val idx = line.indexOf(marker)
        if (idx < 0) return
        val domainsPart = line.substring(0, idx).trim()
        val selector = line.substring(idx + marker.length).trim()
        if (selector.isEmpty() || selector.contains("{")) return

        val exception = marker == "#@#"
        val domains = if (domainsPart.isEmpty()) listOf("")
        else domainsPart.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }

        for (domain in domains) {
            val negated = domain.startsWith("~") && !exception
            val d = if (negated) domain.substring(1) else domain

            if (negated) {
                if (d.isNotEmpty()) {
                    cssExceptions.getOrPut(d) { ArrayList(8) }.add(selector)
                }
                continue
            }
            if (!seen.add((if (exception) "#@#" else "##") + d + "\u0000" + selector)) continue
            if (exception) {
                cssExceptions.getOrPut(d) { ArrayList(8) }.add(selector)
            } else if (d.isEmpty()) {
                if (cssGeneric.size < 1200) cssGeneric.add(selector)
            } else {
                cssDomain.getOrPut(d) { ArrayList(16) }.add(selector)
            }
        }
    }

    private fun firstToken(s: String): String? {
        var best: String? = null
        val sb = StringBuilder()
        for (c in s) {
            if (c.isLetterOrDigit()) {
                sb.append(c)
            } else {
                if (sb.length >= 4 && (best == null || sb.length > best!!.length)) {
                    best = sb.toString().lowercase()
                }
                sb.setLength(0)
            }
        }
        if (sb.length >= 4 && (best == null || sb.length > best!!.length)) {
            best = sb.toString().lowercase()
        }
        return best
    }
}

private fun filterMatches(f: NetFilter, url: String, host: String, pageHost: String): Boolean {
    if (f.thirdPartyOnly && sameParty(host, pageHost)) return false
    if (f.firstPartyOnly && !sameParty(host, pageHost)) return false

    f.includeDomains?.let { inc ->
        if (pageHost.isEmpty() || inc.none { domainMatches(pageHost, it) }) return false
    }
    f.excludeDomains?.let { exc ->
        if (pageHost.isNotEmpty() && exc.any { domainMatches(pageHost, it) }) return false
    }

    if (f.host != null) {
        if (!domainMatches(host, f.host)) return false
        if (f.pattern.isEmpty()) return true
        val idx = url.indexOf(f.host)
        if (idx < 0) return false
        return wildcardMatch(f.pattern, url.substring(idx + f.host.length))
    }
    return wildcardMatch(f.pattern, url)
}

private fun sameParty(host: String, pageHost: String): Boolean {
    if (pageHost.isEmpty()) return true
    return host == pageHost || host.endsWith(".$pageHost") || pageHost.endsWith(".$host")
}

private fun domainMatches(host: String, domain: String): Boolean =
    host == domain || host.endsWith(".$domain")

/**
 * Adblock wildcard matching. `*` matches any sequence, `^` matches a
 * separator or the end of the URL, and `|` anchors start/end.
 */
private fun wildcardMatch(rawPattern: String, text: String): Boolean {
    var p = rawPattern
    var anchoredStart = false
    var anchoredEnd = false
    if (p.startsWith("|")) {
        anchoredStart = true
        p = p.substring(1)
    }
    if (p.endsWith("|")) {
        anchoredEnd = true
        p = p.dropLast(1)
    }
    if (p.isEmpty()) return !anchoredEnd || text.isEmpty()

    fun charMatches(pc: Char, tc: Char): Boolean {
        if (pc == '^') {
            return !(tc.isLetterOrDigit() || tc == '_' || tc == '-' || tc == '.')
        }
        return pc == tc
    }

    fun matchAt(startPos: Int): Boolean {
        var pi = 0
        var ti = startPos
        var starPi = -1
        var starTi = -1
        while (true) {
            if (pi < p.length && p[pi] == '*') {
                starPi = pi
                starTi = ti
                pi++
                continue
            }
            if (pi < p.length && p[pi] == '^' && ti == text.length) {
                pi++
                continue
            }
            if (pi < p.length && ti < text.length && charMatches(p[pi], text[ti])) {
                pi++
                ti++
                continue
            }
            if (starPi >= 0 && starTi < text.length) {
                starTi++
                ti = starTi
                pi = starPi + 1
                continue
            }
            break
        }
        while (pi < p.length && p[pi] == '*') pi++
        if (pi < p.length && p[pi] == '^' && ti == text.length) pi++
        if (pi != p.length) return false
        return !anchoredEnd || ti == text.length
    }

    if (anchoredStart) return matchAt(0)
    var i = 0
    while (i <= text.length) {
        if (matchAt(i)) return true
        i++
    }
    return false
}
