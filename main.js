/**
 * Ferox Browser - Main Process
 * Chromium runtime, Brave Shields integration, IPC routing, and YouTube 3x/4x engine
 */

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const BraveShieldsEngine = require('./engine/shields/adblocker');

let mainWindow = null;
const shieldsEngine = new BraveShieldsEngine();

// Read YouTube turbo script once into memory for ultra-fast injection
const ytTurboScript = fs.readFileSync(path.join(__dirname, 'engine', 'youtube', 'youtube_speed.js'), 'utf8');

// Shields preload runs at document-start inside every webview (cosmetic
// filtering + YouTube anti-adblock defenses). Registered below through
// `will-attach-webview`, which Electron supports since v1.
const shieldsPreloadPath = path.join(__dirname, 'engine', 'shields', 'page_preload.js');

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    title: 'Ferox',
    backgroundColor: '#121217',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true
    }
  });

  // Load the Ferox UI
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Sync window maximize/unmaximize states to renderer
  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-is-maximized', true);
    }
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-is-maximized', false);
    }
  });

  // Forward Shields blocked stats to UI
  shieldsEngine.setOnBlockedListener((stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shields-update', stats);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Initialize Brave Shields network blocker on default session
  await shieldsEngine.initialize(session.defaultSession);

  // Set modern user agent
  session.defaultSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Ferox/1.0'
  );

  // Handle all webviews and webContents
  app.on('web-contents-created', (event, contents) => {
    // Attach cosmetic ad blocking
    shieldsEngine.attachToWebContents(contents);

    // Inject the Ferox Shields preload into every <webview>. This runs at
    // document-start, so cosmetic filters and the YouTube ad shields win the
    // race against page scripts and anti-adblock detection.
    contents.on('will-attach-webview', (event, webPreferences) => {
      delete webPreferences.preloadURL;
      webPreferences.preload = shieldsPreloadPath;
    });

    // Route pop-ups (middle-click / target=_blank / window.open) into a new
    // in-window tab instead of spawning a separate Electron window.
    contents.setWindowOpenHandler((details) => {
      const url = details && details.url;
      if (url && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-in-new-tab', {
          url,
          disposition: (details && details.disposition) || 'foreground-tab'
        });
      }
      return { action: 'deny' };
    });

    // If webview navigates to YouTube, inject the speed engine and ad destroyer
    const injectYouTubeTurbo = () => {
      const url = contents.getURL() || '';
      if (url.includes('youtube.com')) {
        contents.executeJavaScript(ytTurboScript).catch(() => {});
      }
    };

    contents.on('dom-ready', injectYouTubeTurbo);
    contents.on('did-finish-load', injectYouTubeTurbo);
    contents.on('did-navigate-in-page', injectYouTubeTurbo);
  });

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Window Controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// IPC Shields Controls
ipcMain.on('shields-toggle', (_, { enabled }) => {
  shieldsEngine.setShieldsEnabled(enabled);
});

ipcMain.handle('shields-get-stats', () => {
  return shieldsEngine.getBlockedStats();
});
