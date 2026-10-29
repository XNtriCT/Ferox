/**
 * Ferox Browser - README screenshot generator
 *
 * Renders the real renderer UI (renderer/index.html + style.css) inside an
 * Electron window and captures PNGs of the speed toolbar and the mouse speed
 * control mode. The YouTube page is replaced with a local mock watch page so
 * the captures are deterministic and offline.
 *
 * Usage:  npx electron scripts/screenshots/capture.js
 */

const { app, BrowserWindow, session, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'screenshots');
const MOCK_HTML = fs.readFileSync(path.join(__dirname, 'mock_youtube.html'), 'utf8');
const YT_SCRIPT = fs.readFileSync(path.join(ROOT, 'engine', 'youtube', 'youtube_speed.js'), 'utf8');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MOCK_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const mockUrl = `http://127.0.0.1:${server.address().port}/watch`;

  app.on('web-contents-created', (event, contents) => {
    if (contents.getType() !== 'webview') return;
    const inject = () => contents.executeJavaScript(YT_SCRIPT).catch(() => {});
    contents.on('dom-ready', inject);
    contents.on('did-finish-load', inject);
  });

  await app.whenReady();

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://*.youtube.com/*', '*://youtube.com/*'] },
    (details, callback) => callback({ redirectURL: mockUrl })
  );

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    frame: false,
    backgroundColor: '#0d1017',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await wait(600);

  // Treat the mocked webview as a YouTube tab so the badge + speed poller run
  await win.webContents.executeJavaScript(`
    (() => {
      const wv = document.querySelector('webview');
      if (wv) wv.getURL = () => 'https://www.youtube.com/watch?v=ferox-demo';
      const badge = document.getElementById('yt-speed-badge');
      if (badge) badge.style.display = 'flex';
      const urlInput = document.getElementById('url-input');
      if (urlInput) urlInput.value = 'https://www.youtube.com/watch?v=ferox-demo';
      const host = document.getElementById('current-site-host');
      if (host) host.textContent = 'www.youtube.com';
      return true;
    })()
  `);

  win.showInactive();
  await wait(3500);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, name), image.toPNG());
    console.log(`captured ${name}`);
  };

  // 1) Speed toolbar with the 1.75x preset active
  await win.webContents.executeJavaScript(
    `document.querySelector('.speed-btn[data-speed="1.75"]').click(); true`
  );
  await wait(1600);
  await shot('01-speed-toolbar.png');

  // 2) Mouse speed control locked on and tuned to ~1.70x (nearest preset: 1.75x)
  await win.webContents.executeJavaScript(
    `document.querySelector('.speed-btn[data-speed="1.0"]').click(); true`
  );
  await wait(900);

  const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
  await guest.executeJavaScript(`
    (() => {
      document.dispatchEvent(new MouseEvent('mousedown', {
        button: 1, clientX: 420, clientY: 300, bubbles: true, cancelable: true
      }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 420, clientY: 300, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 569, clientY: 300, bubbles: true }));
      return true;
    })()
  `);
  await wait(1600);
  await shot('02-mouse-speed-control.png');

  server.close();
  win.destroy();
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.quit();
});
