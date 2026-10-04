/**
 * Ferox Browser - Renderer UI Controller
 * Tab management, Omnibox, Shields Controller, and Webview orchestration.
 */

document.addEventListener('DOMContentLoaded', () => {
  let tabs = [];
  let activeTabId = null;
  let tabCounter = 0;

  // DOM Elements
  const tabsList = document.getElementById('tabs-list');
  const newTabBtn = document.getElementById('new-tab-btn');
  const urlInput = document.getElementById('url-input');
  const backBtn = document.getElementById('back-btn');
  const forwardBtn = document.getElementById('forward-btn');
  const reloadBtn = document.getElementById('reload-btn');
  const webviewContainer = document.getElementById('webview-container');
  const shieldsBtn = document.getElementById('shields-btn');
  const shieldsModal = document.getElementById('shields-modal');
  const shieldsToggleInput = document.getElementById('shields-toggle-input');
  const shieldsBlockedCount = document.getElementById('shields-blocked-count');
  const shieldStatAds = document.getElementById('shield-stat-ads');
  const currentSiteHost = document.getElementById('current-site-host');
  const quickYtBtn = document.getElementById('quick-yt-btn');
  const minBtn = document.getElementById('min-btn');
  const maxBtn = document.getElementById('max-btn');
  const closeBtn = document.getElementById('close-btn');
  const ytSpeedBadge = document.getElementById('yt-speed-badge');

  // Window Controls
  if (minBtn) minBtn.addEventListener('click', () => window.feroxAPI?.minimize());
  if (maxBtn) maxBtn.addEventListener('click', () => window.feroxAPI?.maximize());
  if (closeBtn) closeBtn.addEventListener('click', () => window.feroxAPI?.close());

  // Double-click titlebar to maximize / unmaximize
  const titlebar = document.getElementById('titlebar');
  if (titlebar) {
    titlebar.addEventListener('dblclick', (e) => {
      if (e.target.closest('#window-controls, .browser-tab, #new-tab-btn, button, input')) return;
      window.feroxAPI?.maximize();
    });
  }

  // Sync Maximize / Restore button state with OS
  if (window.feroxAPI?.onWindowMaximized) {
    window.feroxAPI.onWindowMaximized((isMaximized) => {
      document.body.classList.toggle('window-maximized', isMaximized);
      if (maxBtn) {
        if (isMaximized) {
          maxBtn.title = 'Restore';
          maxBtn.innerHTML = `
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="2.5" y="0.5" width="7" height="7"/>
              <polyline points="0.5 2.5 0.5 9.5 7.5 9.5"/>
            </svg>
          `;
        } else {
          maxBtn.title = 'Maximize';
          maxBtn.innerHTML = `
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0.5" y="0.5" width="9" height="9"/>
            </svg>
          `;
        }
      }
    });
  }

  /**
   * Format input into valid URL or Brave Search query
   */
  function formatSearchOrUrl(input) {
    input = (input || '').trim();
    if (!input) return 'https://search.brave.com';

    // Check if it's already a URL
    if (/^https?:\/\//i.test(input)) {
      return input;
    }

    // Check if it looks like a domain name (e.g. youtube.com, github.com)
    if (/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(input)) {
      return 'https://' + input;
    }

    // Default: Brave Search query
    return `https://search.brave.com/search?q=${encodeURIComponent(input)}`;
  }

  /**
   * Create a new tab
   */
  function createTab(initialUrl = 'https://www.youtube.com', activate = true) {
    tabCounter++;
    const tabId = `tab-${tabCounter}`;
    const url = formatSearchOrUrl(initialUrl);

    // Create webview element
    const webview = document.createElement('webview');
    webview.id = `webview-${tabId}`;
    webview.src = url;
    webview.setAttribute('allowpopups', 'true');
    webview.setAttribute('webpreferences', 'contextIsolation=no');

    webviewContainer.appendChild(webview);

    const tabData = {
      id: tabId,
      title: 'New Tab',
      url: url,
      favicon: 'https://brave.com/static-assets/images/brave-logo.svg',
      webview: webview
    };

    tabs.push(tabData);

    // Create tab element in tabstrip
    const tabEl = document.createElement('div');
    tabEl.className = 'browser-tab';
    tabEl.id = `tab-el-${tabId}`;
    tabEl.innerHTML = `
      <img class="tab-favicon" src="https://brave.com/static-assets/images/brave-logo.svg" alt="icon">
      <span class="tab-title">Loading...</span>
      <button class="tab-close-btn" title="Close tab">✕</button>
    `;

    // Click tab to switch
    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close-btn')) return;
      switchTab(tabId);
    });

    // Middle-click tab to close
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tabId);
      }
    });

    // Close button click
    const closeBtnEl = tabEl.querySelector('.tab-close-btn');
    if (closeBtnEl) {
      closeBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tabId);
      });
    }

    tabsList.appendChild(tabEl);

    // Webview event listeners
    webview.addEventListener('page-title-updated', (e) => {
      tabData.title = e.title;
      const titleSpan = tabEl.querySelector('.tab-title');
      if (titleSpan) titleSpan.textContent = e.title || 'New Tab';
    });

    webview.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons && e.favicons.length > 0) {
        tabData.favicon = e.favicons[0];
        const favImg = tabEl.querySelector('.tab-favicon');
        if (favImg) favImg.src = e.favicons[0];
      }
    });

    webview.addEventListener('did-navigate', (e) => {
      tabData.url = e.url;
      if (activeTabId === tabId) {
        updateOmnibox(e.url);
      }
    });

    webview.addEventListener('did-navigate-in-page', (e) => {
      tabData.url = e.url;
      if (activeTabId === tabId) {
        updateOmnibox(e.url);
      }
    });

    if (activate) switchTab(tabId);
    return tabData;
  }

  /**
   * Switch active tab
   */
  function switchTab(tabId) {
    activeTabId = tabId;
    tabs.forEach((tab) => {
      const tabEl = document.getElementById(`tab-el-${tab.id}`);
      if (tab.id === tabId) {
        tab.webview.classList.add('active');
        if (tabEl) tabEl.classList.add('active');
        updateOmnibox(tab.webview.getURL() || tab.url);
      } else {
        tab.webview.classList.remove('active');
        if (tabEl) tabEl.classList.remove('active');
      }
    });
  }

  /**
   * Close a tab
   */
  function closeTab(tabId) {
    const index = tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const tab = tabs[index];
    if (tab.webview && tab.webview.parentNode) {
      tab.webview.parentNode.removeChild(tab.webview);
    }
    const tabEl = document.getElementById(`tab-el-${tabId}`);
    if (tabEl && tabEl.parentNode) {
      tabEl.parentNode.removeChild(tabEl);
    }

    tabs.splice(index, 1);

    if (tabs.length === 0) {
      createTab('https://www.youtube.com');
    } else if (activeTabId === tabId) {
      const newActive = tabs[Math.max(0, index - 1)];
      switchTab(newActive.id);
    }
  }

  /**
   * Update Omnibox URL & Speed display
   */
  function updateOmnibox(url) {
    urlInput.value = url;
    try {
      const host = new URL(url).hostname;
      currentSiteHost.textContent = host || 'Protected';
    } catch (_) {
      currentSiteHost.textContent = 'Protected';
    }

    if (url.includes('youtube.com')) {
      ytSpeedBadge.style.display = 'flex';
      syncSpeedBadge();
    } else {
      ytSpeedBadge.style.display = 'none';
    }
  }

  /**
   * Sync active video playback speed with omnibox speed badge & toolbar buttons
   */
  function syncSpeedBadge() {
    const wv = getActiveWebview();
    if (!wv) return;

    wv.executeJavaScript(`
      (()=>{
        const activeShort = document.querySelector('ytd-reel-video-renderer[is-active] video') ||
                            document.querySelector('#shorts-player video') ||
                            document.querySelector('.reel-video-in-sequence[is-active] video');
        let rate;
        if (activeShort) {
          rate = activeShort.playbackRate;
        } else {
          const all = Array.from(document.querySelectorAll('video'));
          const playing = all.find(v => !v.paused && v.readyState > 0);
          const mainVideo = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
          rate = playing ? playing.playbackRate
               : (mainVideo ? mainVideo.playbackRate : (all[0] ? all[0].playbackRate : 1));
        }
        return { rate: rate, mouseActive: !!window.__ferox_mouse_speed_active };
      })()
    `)
      .then((res) => {
        if (!res) return;
        const { rate, mouseActive } = res;
        if (rate) {
          if (ytSpeedBadge) {
            const badgeText = ytSpeedBadge.querySelector('.badge-text');
            const rateText = `${parseFloat(rate).toFixed(2).replace(/\.00$/, '')}x`;
            if (badgeText) {
              badgeText.textContent = mouseActive ? `${rateText} · Mouse` : `${rateText} Speed`;
            }
            ytSpeedBadge.classList.toggle('mouse-active', !!mouseActive);
            ytSpeedBadge.title = mouseActive
              ? 'Mouse Speed Control active - move mouse left/right (hold CTRL for normal mouse, wheel-click to exit)'
              : 'Ferox Speed Turbo Active';
          }
          updateSpeedButtonsUI(rate);
        }
      })
      .catch(() => {});
  }

  /**
   * Direct single-tap speed controller for active webview (Shorts & Main)
   */
  function setVideoSpeed(speed) {
    const wv = getActiveWebview();
    if (!wv) return;
    wv.executeJavaScript(`
      (()=>{
        const rate = ${speed};
        const allVideos = document.querySelectorAll('video');
        if (!allVideos || allVideos.length === 0) return null;
        allVideos.forEach((v) => {
          try {
            v.playbackRate = rate;
            v.defaultPlaybackRate = rate;
            if ('preservesPitch' in v) v.preservesPitch = true;
            if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
          } catch (_) {}
        });
        localStorage.setItem('ferox_speed', rate.toString());
        return rate;
      })()
    `).then((rate) => {
      syncSpeedBadge();
      updateSpeedButtonsUI(speed);
    }).catch(() => {});
  }

  function updateSpeedButtonsUI(rate) {
    const parsedRate = parseFloat(rate);
    if (isNaN(parsedRate)) return;

    const buttons = Array.from(document.querySelectorAll('.speed-btn'));
    if (!buttons.length) return;

    // Light up the closest preset button so continuous mouse tuning always
    // shows an approximate speed indication (e.g. 1.70 -> 1.75x).
    let nearest = null;
    let bestDiff = Infinity;
    buttons.forEach((btn) => {
      const diff = Math.abs(parseFloat(btn.dataset.speed) - parsedRate);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = btn;
      }
    });

    buttons.forEach((btn) => btn.classList.toggle('active', btn === nearest));
  }

  // Quick Speed Buttons click listener (Toolbar just below URL bar)
  document.querySelectorAll('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const spd = parseFloat(btn.dataset.speed);
      setVideoSpeed(spd);
    });
  });

  // Periodic speed sync (feeds the toolbar buttons from continuous mouse tuning)
  setInterval(() => {
    const wv = getActiveWebview();
    if (wv && (wv.getURL() || '').includes('youtube.com')) {
      syncSpeedBadge();
    }
  }, 300);

  // Clicking Omnibox Speed Badge cycles through speeds: 1x -> 2x -> 3x -> 4x
  if (ytSpeedBadge) {
    ytSpeedBadge.addEventListener('click', () => {
      const wv = getActiveWebview();
      if (!wv) return;
      wv.executeJavaScript(`
        (()=>{
          const activeShort = document.querySelector('ytd-reel-video-renderer[is-active] video') ||
                              document.querySelector('#shorts-player video') ||
                              document.querySelector('.reel-video-in-sequence[is-active] video');
          const all = Array.from(document.querySelectorAll('video'));
          const activeVideo = activeShort || all.find(v => !v.paused && v.readyState > 0) || all[0];
          if (!activeVideo) return null;

          const speeds = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0];
          let cur = Math.round(activeVideo.playbackRate * 100) / 100;
          let next = speeds[0];
          for (let s of speeds) {
            if (s > cur + 0.05) { next = s; break; }
          }
          all.forEach((v) => {
            try {
              v.playbackRate = next;
              v.defaultPlaybackRate = next;
              if ('preservesPitch' in v) v.preservesPitch = true;
              if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
            } catch (_) {}
          });
          localStorage.setItem('ferox_speed', next.toString());
          return next;
        })()
      `).then((rate) => {
        if (rate) {
          syncSpeedBadge();
          updateSpeedButtonsUI(rate);
        }
      }).catch(() => {});
    });
  }

  /**
   * Navigation actions
   */
  function getActiveWebview() {
    const active = tabs.find((t) => t.id === activeTabId);
    return active ? active.webview : null;
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const wv = getActiveWebview();
      if (wv && wv.canGoBack()) wv.goBack();
    });
  }

  if (forwardBtn) {
    forwardBtn.addEventListener('click', () => {
      const wv = getActiveWebview();
      if (wv && wv.canGoForward()) wv.goForward();
    });
  }

  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      const wv = getActiveWebview();
      if (wv) wv.reload();
    });
  }

  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const targetUrl = formatSearchOrUrl(urlInput.value);
        const wv = getActiveWebview();
        if (wv) {
          wv.loadURL(targetUrl);
        }
      }
    });
  }

  if (newTabBtn) {
    newTabBtn.addEventListener('click', () => {
      createTab('https://www.youtube.com');
    });
  }

  if (quickYtBtn) {
    quickYtBtn.addEventListener('click', () => {
      createTab('https://www.youtube.com');
    });
  }

  // Bookmarks clicks
  document.querySelectorAll('.bookmark-item').forEach((bm) => {
    bm.addEventListener('click', () => {
      const url = bm.dataset.url;
      const wv = getActiveWebview();
      if (wv) {
        wv.loadURL(url);
      } else {
        createTab(url);
      }
    });
  });

  // Shields UI interactions
  if (shieldsBtn && shieldsModal) {
    shieldsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shieldsModal.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!shieldsModal.contains(e.target) && e.target !== shieldsBtn) {
        shieldsModal.classList.add('hidden');
      }
    });
  }

  if (shieldsToggleInput) {
    shieldsToggleInput.addEventListener('change', () => {
      const enabled = shieldsToggleInput.checked;
      window.feroxAPI?.toggleShields(enabled);
    });
  }

  // Shields live stats updates from main process
  if (window.feroxAPI?.onShieldsUpdate) {
    window.feroxAPI.onShieldsUpdate((data) => {
      if (shieldsBlockedCount) shieldsBlockedCount.textContent = data.total || 0;
      if (shieldStatAds) shieldStatAds.textContent = data.total || 0;
    });
  }

  // Pop-ups requested by web pages (middle-click / target=_blank / window.open)
  // open as a new tab in this same window instead of a separate window.
  if (window.feroxAPI?.onOpenInNewTab) {
    window.feroxAPI.onOpenInNewTab((data) => {
      if (data && data.url) {
        const openInBackground = data.disposition === 'background-tab';
        createTab(data.url, !openInBackground);
      }
    });
  }

  // Keyboard Shortcuts: Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+Tab
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createTab('https://www.youtube.com');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (activeTabId) closeTab(activeTabId);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      if (urlInput) urlInput.select();
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (tabs.length > 1) {
        const curIndex = tabs.findIndex((t) => t.id === activeTabId);
        const nextIndex = (curIndex + 1) % tabs.length;
        switchTab(tabs[nextIndex].id);
      }
    }
  });

  // Initial tab on startup: YouTube
  createTab('https://www.youtube.com');
});
