document.querySelectorAll('.btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const speed = parseFloat(btn.dataset.speed);
    if (chrome && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ ferox_speed: speed });
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (s) => {
          document.querySelectorAll('video').forEach((v) => {
            v.playbackRate = s;
            v.defaultPlaybackRate = s;
            if ('preservesPitch' in v) v.preservesPitch = true;
          });
        },
        args: [speed]
      });
    }
  });
});
