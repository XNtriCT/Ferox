/**
 * Ferox Browser - YouTube Speed Turbo (3x / 4x) & Live Speed Indicator Engine
 */

(function () {
  'use strict';

  if (window.__ferox_engine_active) return;
  window.__ferox_engine_active = true;

  console.log('[Ferox] YouTube Speed & Indicator Engine Loaded');

  const SPEED_LEVELS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75, 4.0];
  const POPULAR_SPEEDS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
  const LINEAR_SPEEDS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0];
  // `bravest_speed` is the legacy key kept as a fallback so upgrading users
  // keep their saved playback speed after the Ferox rebrand.
  let currentSpeed =
    parseFloat(localStorage.getItem('ferox_speed') || localStorage.getItem('bravest_speed')) || 1.0;

  // ==========================================
  // 1. YouTube Ad Auto-Skipper + Anti-Adblock Shield
  // ==========================================
  let lastEnforcementAt = 0;
  let adModeActive = false;
  let adSkipTicker = null;
  let adWasMuted = false;
  let adWasPlaying = false;

  const AD_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-text',
    '.videoAdUiSkipButton',
    'button[id^="skip-button"]',
    '.ytp-ad-overlay-close-button'
  ];

  function resumePlaybackIfPaused() {
    if (!lastEnforcementAt || Date.now() - lastEnforcementAt > 5000) return;
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (video && video.paused) {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    }
  }

  function isAdPlaying() {
    if (document.querySelector('.ad-showing, .ad-interrupting')) return true;
    const player = document.getElementById('movie_player');
    if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) {
      return true;
    }
    // Some ad variants only expose the in-player overlay element.
    return !!document.querySelector('.video-ads .ytp-ad-player-overlay, .video-ads .ytp-ad-player-overlay-layout');
  }

  function clickAdSkipButtons() {
    AD_SKIP_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((btn) => {
        try {
          if (btn && !btn.disabled) btn.click();
        } catch (_) {}
      });
    });
  }

  function removeAdSurfaces() {
    document
      .querySelectorAll(
        '.ytp-ad-overlay-container, .ytp-ad-player-overlay, .ytp-ad-image-overlay, .ytp-ad-text-overlay, ytd-ad-slot-renderer, ytd-banner-promo-renderer, #player-ads, #masthead-ad'
      )
      .forEach((el) => {
        try {
          el.remove();
        } catch (_) {}
      });
  }

  /**
   * Hard ad termination. Instead of letting an ad play (even sped up), the
   * media element is repeatedly seeked to its very end until YouTube tears the
   * ad down and starts the real video. The ticker is required because the ad
   * module clamps seeks back during the first moments of an ad.
   */
  function forceAdCompletion() {
    document.querySelectorAll('video').forEach((v) => {
      try {
        v.playbackRate = 16.0; // fallback acceleration if a seek is rejected
        v.muted = true;
        if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.05) {
          v.currentTime = v.duration + 1; // clamps to duration and fires 'ended'
        }
      } catch (_) {}
    });
    clickAdSkipButtons();
    removeAdSurfaces();
  }

  function enterAdMode() {
    if (adModeActive) return;
    adModeActive = true;
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    adWasMuted = video ? !!video.muted : false;
    adWasPlaying = video ? !video.paused : true;
    forceAdCompletion();
    if (!adSkipTicker) adSkipTicker = setInterval(forceAdCompletion, 40);
  }

  function exitAdMode() {
    if (!adModeActive) return;
    adModeActive = false;
    if (adSkipTicker) {
      clearInterval(adSkipTicker);
      adSkipTicker = null;
    }
    document.querySelectorAll('video').forEach((v) => {
      try {
        v.muted = adWasMuted;
        v.playbackRate = currentSpeed;
        v.defaultPlaybackRate = currentSpeed;
        if ('preservesPitch' in v) v.preservesPitch = true;
        if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
      } catch (_) {}
    });
    if (adWasPlaying) {
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (video && video.paused) {
        const attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
      }
    }
    updateAllIndicators(currentSpeed);
  }

  function monitorYouTubeAds() {
    if (isAdPlaying()) {
      if (!adModeActive) enterAdMode();
      else forceAdCompletion();
    } else if (adModeActive) {
      exitAdMode();
    }
  }

  function killYouTubeAds() {
    monitorYouTubeAds();

    document.querySelectorAll('.ytp-ad-overlay-container, ytd-ad-slot-renderer, ytd-banner-promo-renderer, #player-ads, #masthead-ad').forEach((el) => {
      el.remove();
    });

    // Tear down YouTube's "Ad blockers violate YouTube's Terms of Service"
    // enforcement pop-up and un-pause the player it froze.
    document.querySelectorAll('ytd-enforcement-message-view-model').forEach((el) => {
      const dialog = el.closest('tp-yt-paper-dialog') || el;
      dialog.remove();
      document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((backdrop) => backdrop.remove());
      try {
        document.documentElement.style.overflow = '';
        if (document.body) document.body.style.overflow = '';
      } catch (_) {}
      lastEnforcementAt = Date.now();
    });

    document.querySelectorAll('ytd-enforcement-message-view-model button').forEach((btn) => {
      const label = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
      if (label.includes('dismiss') || label.includes('understand')) {
        try {
          btn.click();
        } catch (_) {}
      }
    });

    document.querySelectorAll('tp-yt-paper-toast').forEach((toast) => {
      if (/experiencing interruptions|ad ?blocks?|blocker/i.test(toast.textContent || '')) {
        toast.remove();
      }
    });

    resumePlaybackIfPaused();
  }

  // ==========================================
  // 2. Playback Speed Core Controller
  // ==========================================
  function applySpeed(rate, showToast = true) {
    rate = Math.round(Math.min(Math.max(rate, 0.25), 4.0) * 100) / 100;
    currentSpeed = rate;
    localStorage.setItem('ferox_speed', rate.toString());

    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      video.playbackRate = rate;
      video.defaultPlaybackRate = rate;
      if ('preservesPitch' in video) video.preservesPitch = true;
      if ('webkitPreservesPitch' in video) video.webkitPreservesPitch = true;
    });

    updateAllIndicators(rate);

    if (showToast) {
      showBigCenterSpeedToast(rate);
    }
  }

  // ==========================================
  // 3. Prominent Big Center-Screen Speed Toast
  // ==========================================
  let toastTimer = null;
  function showBigCenterSpeedToast(rate) {
    let toast = document.getElementById('ferox-center-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ferox-center-toast';
      toast.style.cssText = `
        position: fixed;
        top: 15%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.9);
        background: rgba(12, 12, 18, 0.94);
        color: #ff5500;
        font-family: 'Segoe UI', Roboto, sans-serif;
        font-size: 32px;
        font-weight: 800;
        padding: 14px 36px;
        border-radius: 40px;
        border: 2px solid #ff5500;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.85), 0 0 30px rgba(255, 85, 0, 0.6);
        z-index: 2147483647;
        pointer-events: none;
        transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        opacity: 0;
        display: flex;
        align-items: center;
        gap: 12px;
      `;
      document.body.appendChild(toast);
    }

    // Trusted Types safe: build nodes instead of assigning innerHTML.
    while (toast.firstChild) toast.removeChild(toast.firstChild);
    const toastIcon = document.createElement('span');
    toastIcon.style.fontSize = '36px';
    toastIcon.textContent = '🚀';
    const toastLabel = document.createElement('span');
    toastLabel.textContent = `${rate.toFixed(2).replace(/\.00$/, '')}x SPEED`;
    toast.appendChild(toastIcon);
    toast.appendChild(document.createTextNode(' '));
    toast.appendChild(toastLabel);
    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, -50%) scale(1)';

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%, -50%) scale(0.85)';
      }
    }, 1100);
  }

  // ==========================================
  // 4. Always-Visible Persistent Player HUD
  // ==========================================
  function injectPersistentPlayerPill() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return;

    let pill = document.getElementById('ferox-persistent-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'ferox-persistent-pill';
      pill.style.cssText = `
        position: absolute;
        top: 14px;
        left: 14px;
        z-index: 999999;
        display: flex;
        align-items: center;
        background: rgba(14, 14, 22, 0.92);
        backdrop-filter: blur(10px);
        border: 1.5px solid #ff5500;
        border-radius: 20px;
        padding: 4px 12px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7), 0 0 10px rgba(255, 85, 0, 0.3);
        cursor: pointer;
        user-select: none;
        transition: all 0.2s ease;
      `;

      // Trusted Types safe: build nodes instead of assigning innerHTML.
      const pillIcon = document.createElement('span');
      pillIcon.style.cssText = 'font-size:13px; margin-right:5px;';
      pillIcon.textContent = '⚡';
      const pillText = document.createElement('span');
      pillText.id = 'ferox-pill-text';
      pillText.style.cssText = "color:#ffffff; font-weight:800; font-size:13px; font-family:'Segoe UI', sans-serif;";
      pillText.textContent = '1.0x';
      const pillArrow = document.createElement('span');
      pillArrow.style.cssText = 'color:#ff7733; font-size:10px; margin-left:6px; font-weight:600;';
      pillArrow.textContent = '▼';
      pill.appendChild(pillIcon);
      pill.appendChild(pillText);
      pill.appendChild(pillArrow);

      // Quick dropdown menu on click
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSpeedDropdown(pill);
      });

      player.appendChild(pill);
    }

    // Remove obsolete top-right bar if present
    const oldQuickBar = document.getElementById('ferox-quick-bar');
    if (oldQuickBar) oldQuickBar.remove();
  }

  // ==========================================
  // 4b. Linear Speed Bar Just Below Video Player
  // ==========================================
  function injectLinearSpeedBar() {
    const video = document.querySelector('video');
    if (!video) {
      const existingBar = document.getElementById('ferox-linear-speed-bar');
      if (existingBar) existingBar.remove();
      return;
    }

    // Clean up obsolete top-right bar if present
    const oldQuickBar = document.getElementById('ferox-quick-bar');
    if (oldQuickBar) oldQuickBar.remove();

    const moviePlayer = document.querySelector('#movie_player, .html5-video-player');
    const isFullscreen = !!(document.fullscreenElement || (moviePlayer && moviePlayer.classList.contains('ytp-fullscreen')));

    let bar = document.getElementById('ferox-linear-speed-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ferox-linear-speed-bar';

      const label = document.createElement('div');
      label.className = 'ferox-speed-bar-label';
      label.style.cssText = 'display:flex; align-items:center; gap:3px; margin-right:4px; user-select:none;';
      // Trusted Types safe: build nodes instead of assigning innerHTML.
      const labelIcon = document.createElement('span');
      labelIcon.style.cssText = 'font-size:12px; color:#ff5500;';
      labelIcon.textContent = '⚡';
      const labelText = document.createElement('span');
      labelText.style.cssText =
        "font-size:11px; font-weight:800; color:#ff6600; font-family:'Segoe UI', sans-serif; letter-spacing:0.5px;";
      labelText.textContent = 'SPEED:';
      label.appendChild(labelIcon);
      label.appendChild(document.createTextNode(' '));
      label.appendChild(labelText);
      bar.appendChild(label);

      LINEAR_SPEEDS.forEach((spd) => {
        const btn = document.createElement('button');
        btn.className = 'ferox-speed-select-btn';
        btn.dataset.speed = spd.toString();
        btn.textContent = `${spd}x`;
        btn.title = `Switch to ${spd}x speed (Single Tap)`;
        btn.style.cssText = `
          background: rgba(26, 26, 38, 0.85);
          color: #d0d0e0;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 7px;
          min-width: 30px;
          height: 22px;
          cursor: pointer;
          font-family: 'Segoe UI', Roboto, sans-serif;
          transition: all 0.15s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          user-select: none;
        `;

        btn.addEventListener('mouseenter', () => {
          if (Math.abs(parseFloat(btn.dataset.speed) - currentSpeed) >= 0.05) {
            btn.style.background = 'rgba(45, 45, 65, 0.95)';
            btn.style.color = '#ffffff';
            btn.style.borderColor = 'rgba(255, 85, 0, 0.45)';
          }
        });

        btn.addEventListener('mouseleave', () => {
          if (Math.abs(parseFloat(btn.dataset.speed) - currentSpeed) >= 0.05) {
            btn.style.background = 'rgba(26, 26, 38, 0.85)';
            btn.style.color = '#d0d0e0';
            btn.style.borderColor = 'rgba(255, 255, 255, 0.12)';
          }
        });

        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          applySpeed(spd, true);
        });

        bar.appendChild(btn);
      });
    }

    if (isFullscreen && moviePlayer) {
      // In fullscreen mode: anchor cleanly at the lower edge of the player
      bar.style.cssText = `
        position: absolute;
        bottom: 50px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: 4px;
        background: rgba(12, 12, 18, 0.94);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 85, 0, 0.4);
        border-radius: 8px;
        padding: 4px 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.8);
      `;
      if (bar.parentElement !== moviePlayer) {
        moviePlayer.appendChild(bar);
      }
    } else {
      // Normal mode: position directly below the video player, aligned linearly
      bar.style.cssText = `
        position: relative;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
        margin: 6px 0 8px 0;
        padding: 5px 10px;
        background: rgba(16, 16, 24, 0.95);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 85, 0, 0.28);
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        z-index: 1000;
        max-width: 100%;
        box-sizing: border-box;
      `;

      // Find target anchor: immediately below video player, before #below
      const below = document.querySelector('#below');
      const playerContainer = document.querySelector('#player-container-outer') ||
                              document.querySelector('#player-container') ||
                              document.querySelector('#player');

      if (below && below.parentElement) {
        if (bar.nextElementSibling !== below) {
          below.parentElement.insertBefore(bar, below);
        }
      } else if (playerContainer && playerContainer.parentElement) {
        if (bar.previousElementSibling !== playerContainer) {
          playerContainer.insertAdjacentElement('afterend', bar);
        }
      } else if (moviePlayer && moviePlayer.parentElement) {
        if (bar.previousElementSibling !== moviePlayer) {
          moviePlayer.insertAdjacentElement('afterend', bar);
        }
      } else if (video.parentElement) {
        if (bar.previousElementSibling !== video) {
          video.insertAdjacentElement('afterend', bar);
        }
      }
    }
  }

  // Speed dropdown popup attached to the pill
  function toggleSpeedDropdown(pill) {
    let dropdown = document.getElementById('ferox-speed-dropdown');
    if (dropdown) {
      dropdown.remove();
      return;
    }

    dropdown = document.createElement('div');
    dropdown.id = 'ferox-speed-dropdown';
    dropdown.style.cssText = `
      position: absolute;
      top: 48px;
      left: 14px;
      z-index: 2147483647;
      background: rgba(14, 14, 22, 0.96);
      backdrop-filter: blur(12px);
      border: 1px solid #ff5500;
      border-radius: 10px;
      padding: 8px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.9), 0 0 15px rgba(255, 85, 0, 0.4);
      width: 220px;
    `;

    SPEED_LEVELS.forEach((spd) => {
      const btn = document.createElement('button');
      btn.textContent = `${spd}x`;
      const isActive = Math.abs(spd - currentSpeed) < 0.05;
      btn.style.cssText = `
        background: ${isActive ? '#ff5500' : 'rgba(30, 30, 44, 0.9)'};
        color: ${isActive ? '#ffffff' : '#e0e0e0'};
        font-weight: ${isActive ? '800' : '600'};
        border: 1px solid ${isActive ? '#ff5500' : 'rgba(255, 255, 255, 0.1)'};
        border-radius: 6px;
        padding: 6px 0;
        font-size: 12px;
        cursor: pointer;
        text-align: center;
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        applySpeed(spd, true);
        dropdown.remove();
      });

      dropdown.appendChild(btn);
    });

    const player = document.querySelector('#movie_player, .html5-video-player') || document.body;
    player.appendChild(dropdown);

    const closeDropdown = (e) => {
      if (!dropdown.contains(e.target) && e.target !== pill) {
        dropdown.remove();
        document.removeEventListener('click', closeDropdown);
      }
    };
    setTimeout(() => document.addEventListener('click', closeDropdown), 10);
  }

  // ==========================================
  // 5. In-Player Control Bar (Bottom Right)
  // ==========================================
  function injectBottomControlBadge() {
    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return;

    let bottomBadge = document.getElementById('ferox-bottom-speed-badge');
    if (!bottomBadge) {
      bottomBadge = document.createElement('button');
      bottomBadge.id = 'ferox-bottom-speed-badge';
      bottomBadge.className = 'ytp-button';
      bottomBadge.title = 'Ferox Speed Controller (Click to select)';
      bottomBadge.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #ff5500;
        font-weight: 800;
        font-size: 12px;
        padding: 0 8px;
        cursor: pointer;
        user-select: none;
        vertical-align: top;
      `;

      bottomBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        const pill = document.getElementById('ferox-persistent-pill');
        if (pill) toggleSpeedDropdown(pill);
      });

      rightControls.insertBefore(bottomBadge, rightControls.firstChild);
    }
  }

  // ==========================================
  // 6. Active Video Selector (Shorts & Main)
  // ==========================================
  function getActiveVideo() {
    const activeShort = document.querySelector('ytd-reel-video-renderer[is-active] video') ||
                        document.querySelector('#shorts-player video') ||
                        document.querySelector('.reel-video-in-sequence[is-active] video');
    if (activeShort) return activeShort;

    const allVideos = Array.from(document.querySelectorAll('video'));
    const playing = allVideos.find((v) => !v.paused && v.readyState > 0);
    if (playing) return playing;

    const mainVideo = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
    if (mainVideo) return mainVideo;

    return allVideos[0] || null;
  }

  // ==========================================
  // 6b. Update All UI Indicators
  // ==========================================
  function updateAllIndicators(rate) {
    const rateText = `${rate.toFixed(2).replace(/\.00$/, '')}x`;

    // 1. Update Top-Left Pill
    const pillText = document.getElementById('ferox-pill-text');
    if (pillText) {
      pillText.textContent = rateText;
    }

    // 2. Update Bottom-Right Control Badge (Trusted Types safe)
    const bottomBadge = document.getElementById('ferox-bottom-speed-badge');
    if (bottomBadge) {
      while (bottomBadge.firstChild) bottomBadge.removeChild(bottomBadge.firstChild);
      const badgeIcon = document.createElement('span');
      badgeIcon.style.cssText = 'color:#ff5500; font-size:11px; margin-right:2px;';
      badgeIcon.textContent = '⚡';
      bottomBadge.appendChild(badgeIcon);
      bottomBadge.appendChild(document.createTextNode(rateText));
    }

    // 3. Update Linear Speed Buttons
    document.querySelectorAll('.ferox-speed-select-btn').forEach((btn) => {
      const sp = parseFloat(btn.dataset.speed);
      if (Math.abs(sp - rate) < 0.05) {
        btn.style.background = '#ff5500';
        btn.style.color = '#ffffff';
        btn.style.borderColor = '#ff7733';
        btn.style.boxShadow = '0 0 8px rgba(255, 85, 0, 0.6)';
        btn.style.fontWeight = '800';
      } else {
        btn.style.background = 'rgba(26, 26, 38, 0.85)';
        btn.style.color = '#d0d0e0';
        btn.style.borderColor = 'rgba(255, 255, 255, 0.12)';
        btn.style.boxShadow = 'none';
        btn.style.fontWeight = '600';
      }
    });
  }

  // Auto-enforce chosen speed whenever any video (Shorts or Main) starts playing or loads
  ['play', 'playing', 'loadeddata'].forEach((evt) => {
    document.addEventListener(
      evt,
      (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          const v = e.target;
          const targetSpeed = parseFloat(localStorage.getItem('ferox_speed')) || currentSpeed;
          if (targetSpeed && !document.querySelector('.ad-showing')) {
            try {
              v.playbackRate = targetSpeed;
              v.defaultPlaybackRate = targetSpeed;
              if ('preservesPitch' in v) v.preservesPitch = true;
              if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
            } catch (_) {}
          }
        }
      },
      true
    );
  });

  // ==========================================
  // 7. Keyboard Hotkeys
  // ==========================================
  window.addEventListener(
    'keydown',
    (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

      const video = getActiveVideo();
      if (!video) return;

      // Shift + > or ] key (Speed up)
      if ((e.shiftKey && (e.key === '>' || e.key === '.')) || e.key === ']') {
        e.stopImmediatePropagation();
        e.preventDefault();
        const cur = Math.round(video.playbackRate * 100) / 100;
        let next = 4.0;
        for (let i = 0; i < SPEED_LEVELS.length; i++) {
          if (SPEED_LEVELS[i] > cur + 0.05) {
            next = SPEED_LEVELS[i];
            break;
          }
        }
        applySpeed(next, true);
      }

      // Shift + < or [ key (Speed down)
      if ((e.shiftKey && (e.key === '<' || e.key === ',')) || e.key === '[') {
        e.stopImmediatePropagation();
        e.preventDefault();
        const cur = Math.round(video.playbackRate * 100) / 100;
        let prev = 0.25;
        for (let i = SPEED_LEVELS.length - 1; i >= 0; i--) {
          if (SPEED_LEVELS[i] < cur - 0.05) {
            prev = SPEED_LEVELS[i];
            break;
          }
        }
        applySpeed(prev, true);
      }
    },
    true
  );

  // ==========================================
  // 9. Mouse Speed Control (Wheel-Click Lock Mode)
  // ==========================================
  let mouseSpeedActive = false;
  let ctrlHeld = false;
  let lastMouseX = null;
  let middleClickHandled = false;
  let mouseRawSpeed = 1;

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function formatSpeedText(rate) {
    return `${rate.toFixed(2).replace(/\.00$/, '')}x`;
  }

  function updateMouseSpeedHud(rate) {
    if (!mouseSpeedActive) return;
    const hud = document.getElementById('ferox-mouse-speed-hud');
    if (!hud) return;
    const valueEl = hud.querySelector('.ferox-mouse-value');
    if (valueEl) valueEl.textContent = formatSpeedText(rate);
  }

  function showMouseSpeedHud() {
    let hud = document.getElementById('ferox-mouse-speed-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'ferox-mouse-speed-hud';
      hud.style.cssText = `
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(12, 12, 18, 0.94);
        backdrop-filter: blur(10px);
        border: 1.5px solid #ff5500;
        border-radius: 24px;
        padding: 7px 18px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.8), 0 0 20px rgba(255, 85, 0, 0.45);
        font-family: 'Segoe UI', Roboto, sans-serif;
        user-select: none;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.18s ease;
      `;
      // Trusted Types safe: build nodes instead of assigning innerHTML.
      const hudIcon = document.createElement('span');
      hudIcon.style.fontSize = '15px';
      hudIcon.textContent = '🖱️';
      const hudTitle = document.createElement('span');
      hudTitle.style.cssText = 'color:#ffffff; font-weight:800; font-size:15px;';
      hudTitle.textContent = 'Mouse Speed';
      const hudValue = document.createElement('span');
      hudValue.className = 'ferox-mouse-value';
      hudValue.style.cssText = 'color:#ff7733; font-weight:800; font-size:16px; min-width:54px; text-align:center;';
      hudValue.textContent = '1x';
      const hudHint = document.createElement('span');
      hudHint.style.cssText = 'color:#8a8aa0; font-size:10.5px; font-weight:600;';
      hudHint.textContent = 'move ↔  |  CTRL = normal  |  wheel-click = off';
      hud.appendChild(hudIcon);
      hud.appendChild(hudTitle);
      hud.appendChild(hudValue);
      hud.appendChild(hudHint);
      document.body.appendChild(hud);
    }
    hud.style.display = 'flex';
    requestAnimationFrame(() => {
      hud.style.opacity = '1';
    });
  }

  function hideMouseSpeedHud() {
    const hud = document.getElementById('ferox-mouse-speed-hud');
    if (hud) hud.style.opacity = '0';
  }

  function setMouseSpeedActive(active) {
    mouseSpeedActive = active;
    window.__ferox_mouse_speed_active = active;
    lastMouseX = null;
    if (active) {
      const video = getActiveVideo();
      mouseRawSpeed = video ? video.playbackRate : currentSpeed;
      showMouseSpeedHud();
      updateMouseSpeedHud(video ? video.playbackRate : currentSpeed);
    } else {
      hideMouseSpeedHud();
    }
  }

  // Middle mouse button (wheel click) toggles the lock mode
  document.addEventListener(
    'mousedown',
    (e) => {
      middleClickHandled = false;
      if (e.button !== 1) return;
      // Hold CTRL to use the mouse normally (open links in new tabs, autoscroll, etc.)
      if (ctrlHeld) return;
      if (isTypingTarget(e.target)) return;
      if (!getActiveVideo()) return;
      middleClickHandled = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMouseSpeedActive(!mouseSpeedActive);
    },
    true
  );

  // Suppress autoscroll / link-open defaults caused by the locking wheel click
  document.addEventListener(
    'auxclick',
    (e) => {
      if (e.button === 1 && middleClickHandled) {
        e.preventDefault();
        e.stopPropagation();
        middleClickHandled = false;
      }
    },
    true
  );

  // Horizontal mouse movement continuously tunes playback speed (1x - 4x)
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!mouseSpeedActive || ctrlHeld) {
        lastMouseX = null;
        return;
      }
      if (!getActiveVideo()) return;

      if (lastMouseX === null) {
        lastMouseX = e.clientX;
        return;
      }

      const dx = e.clientX - lastMouseX;
      lastMouseX = e.clientX;
      if (!dx) return;

      // Sweeping roughly half the viewport horizontally spans the full 1x - 4x range.
      // Accumulate on an unrounded value so slow, fine movements still register.
      const sensitivity = 3 / (Math.max(window.innerWidth, 640) * 0.5);
      mouseRawSpeed = Math.min(4, Math.max(1, mouseRawSpeed + dx * sensitivity));

      const rounded = Math.round(mouseRawSpeed * 100) / 100;
      if (Math.abs(rounded - currentSpeed) < 0.001) return;

      applySpeed(rounded, false);
      updateMouseSpeedHud(currentSpeed);
    },
    true
  );

  // Hold CTRL to temporarily use the mouse normally without leaving the lock mode
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Control') {
        ctrlHeld = true;
        lastMouseX = null;
      }
    },
    true
  );

  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Control') {
        ctrlHeld = false;
        lastMouseX = null;
      }
    },
    true
  );

  window.addEventListener('blur', () => {
    ctrlHeld = false;
    lastMouseX = null;
  });

  document.addEventListener('mouseleave', () => {
    lastMouseX = null;
  });

  // ==========================================
  // 8. Continuous Monitor Loop
  // ==========================================
  setInterval(() => {
    // Adopt speeds set from the browser toolbar / other sources
    const storedSpeed = parseFloat(localStorage.getItem('ferox_speed'));
    if (!isNaN(storedSpeed) && Math.abs(storedSpeed - currentSpeed) > 0.001) {
      currentSpeed = storedSpeed;
      mouseRawSpeed = storedSpeed;
    }

    killYouTubeAds();
    injectPersistentPlayerPill();
    injectLinearSpeedBar();
    injectBottomControlBadge();

    // Enforce speed on ALL active & preloaded videos (Shorts feed & Main)
    const videos = document.querySelectorAll('video');
    videos.forEach((v) => {
      if (currentSpeed && Math.abs(v.playbackRate - currentSpeed) > 0.05) {
        if (!document.querySelector('.ad-showing')) {
          try {
            v.playbackRate = currentSpeed;
            v.defaultPlaybackRate = currentSpeed;
            if ('preservesPitch' in v) v.preservesPitch = true;
            if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = true;
          } catch (_) {}
        }
      }
    });

    const activeVideo = getActiveVideo();
    const activeRate = activeVideo ? activeVideo.playbackRate : currentSpeed;
    updateAllIndicators(activeRate);
    updateMouseSpeedHud(activeRate);
  }, 400);

  // Fast dedicated ad watcher: detects ads and hard-ends them almost
  // immediately (~50ms) instead of letting them play out at high speed.
  setInterval(monitorYouTubeAds, 50);

  // Initial load
  setTimeout(() => {
    applySpeed(currentSpeed, false);
    injectPersistentPlayerPill();
    injectLinearSpeedBar();
    injectBottomControlBadge();
  }, 500);
})();
