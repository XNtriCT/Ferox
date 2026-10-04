/**
 * Ferox Browser - Webview Preload Script
 * Injects YouTube 3x/4x speed controls and anti-ad scriptlets on web pages
 */

const fs = require('fs');
const path = require('path');

window.addEventListener('DOMContentLoaded', () => {
  const hostname = window.location.hostname;

  // If on YouTube, load the YouTube 3x/4x playback speed engine
  if (hostname.includes('youtube.com')) {
    const ytScriptPath = path.join(__dirname, 'youtube_speed.js');
    try {
      const scriptCode = fs.readFileSync(ytScriptPath, 'utf8');
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.textContent = scriptCode;
      (document.head || document.documentElement).appendChild(script);
      console.log('[Ferox Webview] Injected YouTube speed engine into YouTube page.');
    } catch (e) {
      console.error('[Ferox Webview] Failed to read/inject youtube_speed.js:', e);
    }
  }
});
