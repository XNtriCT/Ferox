/**
 * Ferox Extension - YouTube 3x/4x Speed Turbo Content Script
 */

(function () {
  'use strict';

  if (window.__ferox_ext_initialized) return;
  window.__ferox_ext_initialized = true;

  console.log('[Ferox Extension] YouTube 3x/4x Turbo initialized.');

  const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
  const QUICK_HUD_PRESETS = [1, 1.5, 2, 3, 4];

  function getStoredSpeed(cb) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['ferox_speed', 'bravest_speed'], (res) => {
        cb(parseFloat(res.ferox_speed || res.bravest_speed) || 1.0);
      });
    } else {
      cb(parseFloat(localStorage.getItem('ferox_speed') || localStorage.getItem('bravest_speed')) || 1.0);
    }
  }

  function saveStoredSpeed(speed) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ ferox_speed: speed });
    }
    localStorage.setItem('ferox_speed', speed.toString());
  }

  function setVideoSpeed(rate) {
    rate = Math.min(Math.max(rate, 0.25), 4.0);
    document.querySelectorAll('video').forEach((v) => {
      v.playbackRate = rate;
      v.defaultPlaybackRate = rate;
      if ('preservesPitch' in v) v.preservesPitch = true;
    });

    saveStoredSpeed(rate);
    updateHudIndicator(rate);
    showToast(`${rate}x`);
  }

  let toastTimeout = null;
  function showToast(text) {
    let toast = document.getElementById('ferox-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ferox-toast';
      toast.style.cssText = `
        position: absolute;
        top: 12%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 15, 25, 0.9);
        color: #ff5500;
        font-family: 'Segoe UI', Roboto, sans-serif;
        font-size: 22px;
        font-weight: 700;
        padding: 6px 20px;
        border-radius: 16px;
        border: 1px solid rgba(255, 85, 0, 0.5);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        z-index: 999999;
        pointer-events: none;
        transition: opacity 0.2s ease;
        opacity: 0;
      `;
      const player = document.querySelector('.html5-video-player') || document.body;
      player.appendChild(toast);
    }

    toast.textContent = `🚀 ${text}`;
    toast.style.opacity = '1';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      if (toast) toast.style.opacity = '0';
    }, 850);
  }

  function updateHudIndicator(rate) {
    document.querySelectorAll('.ferox-hud-btn').forEach((btn) => {
      const sp = parseFloat(btn.dataset.speed);
      if (Math.abs(sp - rate) < 0.05) {
        btn.style.background = '#ff5500';
        btn.style.color = '#ffffff';
        btn.style.fontWeight = 'bold';
      } else {
        btn.style.background = 'rgba(20, 20, 30, 0.85)';
        btn.style.color = '#cccccc';
        btn.style.fontWeight = 'normal';
      }
    });
  }

  function injectHud() {
    const player = document.querySelector('.html5-video-player');
    if (!player || document.getElementById('ferox-hud-container')) return;

    const hud = document.createElement('div');
    hud.id = 'ferox-hud-container';
    hud.style.cssText = `
      position: absolute;
      top: 12px;
      right: 68px;
      display: flex;
      gap: 4px;
      z-index: 9999;
      background: rgba(12, 12, 18, 0.8);
      backdrop-filter: blur(8px);
      padding: 4px 6px;
      border-radius: 8px;
      border: 1px solid rgba(255, 85, 0, 0.35);
      box-shadow: 0 2px 10px rgba(0,0,0,0.5);
    `;

    const label = document.createElement('span');
    label.textContent = '⚡ Speed:';
    label.style.cssText = `
      color: #ff7733;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      padding-right: 4px;
      user-select: none;
      font-family: Roboto, Arial, sans-serif;
    `;
    hud.appendChild(label);

    QUICK_HUD_PRESETS.forEach((speed) => {
      const btn = document.createElement('button');
      btn.className = 'ferox-hud-btn';
      btn.dataset.speed = speed.toString();
      btn.textContent = `${speed}x`;
      btn.style.cssText = `
        background: rgba(20, 20, 30, 0.85);
        color: #cccccc;
        border: none;
        border-radius: 4px;
        font-size: 11px;
        padding: 3px 6px;
        cursor: pointer;
        font-family: Roboto, Arial, sans-serif;
        transition: all 0.15s;
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        setVideoSpeed(speed);
      });
      hud.appendChild(btn);
    });

    player.appendChild(hud);
    const video = player.querySelector('video');
    if (video) updateHudIndicator(video.playbackRate);
  }

  // Keyboard shortcut scaling up to 4x
  window.addEventListener(
    'keydown',
    (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

      const video = document.querySelector('video');
      if (!video) return;

      if (e.shiftKey && (e.key === '>' || e.key === '.')) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const current = Math.round(video.playbackRate * 100) / 100;
        let next = 4.0;
        for (let i = 0; i < SPEED_PRESETS.length; i++) {
          if (SPEED_PRESETS[i] > current + 0.05) {
            next = SPEED_PRESETS[i];
            break;
          }
        }
        setVideoSpeed(next);
      } else if (e.shiftKey && (e.key === '<' || e.key === ',')) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const current = Math.round(video.playbackRate * 100) / 100;
        let prev = 0.25;
        for (let i = SPEED_PRESETS.length - 1; i >= 0; i--) {
          if (SPEED_PRESETS[i] < current - 0.05) {
            prev = SPEED_PRESETS[i];
            break;
          }
        }
        setVideoSpeed(prev);
      }
    },
    true
  );

  // Apply speed to newly loaded video elements
  setInterval(() => {
    injectHud();
    getStoredSpeed((stored) => {
      if (stored && stored !== 1.0) {
        document.querySelectorAll('video').forEach((v) => {
          if (!v.dataset.feroxTracked) {
            v.dataset.feroxTracked = 'true';
            v.playbackRate = stored;
            if ('preservesPitch' in v) v.preservesPitch = true;
          }
        });
      }
    });
  }, 1200);
})();
