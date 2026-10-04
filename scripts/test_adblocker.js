/**
 * Ferox Shields - automated verification harness.
 *
 * Run with:  npx electron scripts/test_adblocker.js
 *
 * Covers:
 *   1. Baseline engine parsing and filter matching (ads blocked, legit allowed)
 *   2. Document-start preload injection of cosmetic filters
 *   3. End-to-end session network blocking
 *   4. Shields on/off toggle
 *   5. YouTube anti-adblock shield installation at document-start
 */

'use strict';

const { app, session, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const BraveShieldsEngine = require('../engine/shields/adblocker');
const { Request } = require('@ghostery/adblocker-electron');

app.disableHardwareAcceleration();

const YT_PAGE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} :: ${err.message}`]);
  }
}

function requestFor(url, type = 'script', sourceUrl = YT_PAGE) {
  return Request.fromRawDetails({
    url,
    type,
    sourceUrl,
    requestId: `${Math.random()}`
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const shields = new BraveShieldsEngine();
  await shields.initialize(session.defaultSession, { offline: true });

  /* 1. Engine matching ---------------------------------------------------- */
  check('baseline engine has filters', () => assert.ok(shields.ruleCount > 80, `rules=${shields.ruleCount}`));
  check('google ads script blocked', () =>
    assert.ok(shields.engine.match(requestFor('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')).match));
  check('doubleclick blocked', () =>
    assert.ok(shields.engine.match(requestFor('https://securepubads.g.doubleclick.net/tag/js/gpt.js')).match));
  check('youtube api/stats/ads blocked', () =>
    assert.ok(shields.engine.match(requestFor('https://www.youtube.com/api/stats/ads?ver=2')).match));
  check('youtube player/ad_break blocked', () =>
    assert.ok(shields.engine.match(requestFor('https://www.youtube.com/youtubei/v1/player/ad_break?key=x')).match));
  check('youtube midroll info blocked', () =>
    assert.ok(shields.engine.match(requestFor('https://www.youtube.com/get_midroll_info?x=1')).match));
  check('youtube player API still allowed', () =>
    assert.ok(!shields.engine.match(requestFor('https://www.youtube.com/youtubei/v1/player?key=x')).match));
  check('googlevideo stream still allowed', () =>
    assert.ok(
      !shields.engine.match(
        requestFor('https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1', 'media')
      ).match
    ));
  check('youtube static assets still allowed', () =>
    assert.ok(!shields.engine.match(requestFor('https://www.youtube.com/s/desktop/abc/jsbin/desktop_polymer.vflset/desktop_polymer.js')).match));

  /* 2. Cosmetics ---------------------------------------------------------- */
  const ytCosmetics = shields.getCosmeticsForUrl(YT_PAGE);
  check('youtube cosmetics active', () => assert.ok(ytCosmetics.active !== false));
  check('youtube cosmetic styles non-empty', () => assert.ok(ytCosmetics.styles.length > 0, `len=${ytCosmetics.styles.length}`));
  const genericCosmetics = shields.getCosmeticsForUrl('https://example.com/');
  check('generic cosmetics non-empty', () =>
    assert.ok(genericCosmetics.styles.includes('adsbygoogle'), `styles=${genericCosmetics.styles.slice(0, 80)}`));

  /* 3. Session-level network blocking ------------------------------------- */
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false }
  });
  await probe.loadURL('data:text/html,<html><body>probe</body></html>');
  const before = shields.getBlockedStats().totalBlocked;
  await probe.webContents.executeJavaScript(`
    Promise.allSettled([
      fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'),
      fetch('https://securepubads.g.doubleclick.net/tag/js/gpt.js')
    ]).then(() => true)
  `);
  await sleep(1200);
  const after = shields.getBlockedStats().totalBlocked;
  check('session blocking cancels ad requests', () => assert.ok(after >= before + 2, `${before} -> ${after}`));

  /* 4. Shields toggle ------------------------------------------------------ */
  shields.setShieldsEnabled(false);
  const offBefore = shields.getBlockedStats().totalBlocked;
  await probe.webContents
    .executeJavaScript(`fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js').catch(() => 0)`)
    .catch(() => {});
  await sleep(1000);
  const offAfter = shields.getBlockedStats().totalBlocked;
  check('shields OFF stops counting', () => assert.equal(offAfter, offBefore, `${offBefore} -> ${offAfter}`));
  shields.setShieldsEnabled(true);
  check('shields can be re-enabled', () => assert.ok(shields.getBlockedStats().shieldsEnabled === true));

  /* 5. Document-start preload (local HTTP server) -------------------------- */
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/adtest') {
      res.end(
        '<!doctype html><html><head><title>adtest</title></head><body>' +
          '<div id="movie_player" class="ad-showing">' +
          '<video></video>' +
          '<button class="ytp-ad-skip-button">Skip Ad</button>' +
          '</div></body></html>'
      );
      return;
    }
    res.end('<!doctype html><html><head><title>probe</title></head><body>probe</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const preloadWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'engine', 'shields', 'page_preload.js'),
      contextIsolation: false,
      sandbox: false
    }
  });
  await preloadWindow.loadURL(`http://127.0.0.1:${port}/`);
  await sleep(400);
  const preloadState = await preloadWindow.webContents.executeJavaScript(`
    ({
      shieldStyles: document.querySelectorAll('style[data-ferox-shields]').length,
      styleText: (document.querySelector('style[data-ferox-shields]') || {}).textContent || '',
      engineIsolatedStub: typeof window.__ferox_shields_probe
    })
  `);
  check('preload injects shields styles at document-start', () =>
    assert.ok(preloadState.shieldStyles > 0 && preloadState.styleText.includes('adsbygoogle'), JSON.stringify(preloadState).slice(0, 200)));
  preloadWindow.destroy();

  /* 6. Fast ad hard-skip state machine ------------------------------------ */
  try {
    const adWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, sandbox: false }
    });
    await adWindow.loadURL(`http://127.0.0.1:${port}/adtest`);
    await adWindow.webContents.executeJavaScript(`
      (function () {
        var v = document.querySelector('video');
        Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 30; } });
        Object.defineProperty(v, 'currentTime', {
          configurable: true,
          get: function () { return window.__ct || 0; },
          set: function (value) { window.__ct = value; window.__seeks = (window.__seeks || 0) + 1; window.__lastSeek = value; }
        });
        window.__skipClicks = 0;
        var skipButton = document.querySelector('.ytp-ad-skip-button');
        if (skipButton) skipButton.addEventListener('click', function () { window.__skipClicks++; });
        true;
      })()
    `);
    const ytScript = fs.readFileSync(
      path.join(__dirname, '..', 'engine', 'youtube', 'youtube_speed.js'),
      'utf8'
    );
    await adWindow.webContents.executeJavaScript(ytScript);
    await sleep(400);
    const adState = await adWindow.webContents.executeJavaScript(`
      (function () {
        var v = document.querySelector('video');
        return {
          muted: v.muted,
          rate: v.playbackRate,
          clicks: window.__skipClicks || 0,
          seeks: window.__seeks || 0,
          lastSeek: window.__lastSeek
        };
      })()
    `);
    check('ad is muted + accelerated instantly', () =>
      assert.ok(adState.muted === true && adState.rate >= 16, JSON.stringify(adState)));
    check('ad media force-seeked to its end', () =>
      assert.ok(adState.seeks > 0 && adState.lastSeek === 31, JSON.stringify(adState)));
    check('ad skip button auto-clicked', () => assert.ok(adState.clicks > 0, JSON.stringify(adState)));

    await adWindow.webContents.executeJavaScript(
      `document.getElementById('movie_player').classList.remove('ad-showing'); true;`
    );
    await sleep(400);
    const postAdState = await adWindow.webContents.executeJavaScript(`
      (function () {
        var v = document.querySelector('video');
        return { muted: v.muted, rate: v.playbackRate };
      })()
    `);
    check('playback state restored after ad', () =>
      assert.ok(postAdState.muted === false && Math.abs(postAdState.rate - 1) < 0.01, JSON.stringify(postAdState)));
    adWindow.destroy();
  } catch (err) {
    results.push(['FAIL', `ad skip state machine (${err.message})`]);
  }
  server.close();

  /* 6. YouTube shield installed at document-start -------------------------- */
  try {
    const ytWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'engine', 'shields', 'page_preload.js'),
        contextIsolation: false,
        sandbox: false
      }
    });
    ytWindow.loadURL('https://www.youtube.com/').catch(() => {});
    let shieldActive = false;
    for (let attempt = 0; attempt < 15 && !shieldActive; attempt++) {
      await sleep(400);
      try {
        shieldActive = await ytWindow.webContents.executeJavaScript(
          'window.__feroxYouTubeShield === true'
        );
      } catch (_) {}
    }
    check('youtube anti-adblock shield installed', () => assert.ok(shieldActive === true));
    ytWindow.destroy();
  } catch (err) {
    results.push(['SKIP', `youtube live check (${err.message})`]);
  }

  probe.destroy();

  /* Report ---------------------------------------------------------------- */
  console.log('');
  for (const [status, name] of results) console.log(`[${status}] ${name}`);
  const failed = results.filter(([status]) => status === 'FAIL');
  console.log('');
  console.log(`RESULT: ${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(main).catch((err) => {
  console.error('Test harness crashed:', err);
  app.exit(1);
});
