// ISOLATED-world content script — the only side that can talk to chrome.*.
// It relays tagged page messages from the MAIN-world hook to the background,
// and control messages (e.g. popup's force resync) back into the page.

(() => {
  const TAG = 'acns';

  // background → page: forward control messages to the MAIN-world hook.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'control' && msg.type === 'refetch') {
      window.postMessage({ __source: `${TAG}-ctl`, type: 'refetch' }, location.origin);
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== TAG) return;

    // After an extension reload, this (now-stale) content script's context is
    // invalidated: chrome.runtime.id goes undefined and sendMessage throws
    // SYNCHRONOUSLY (so .catch can't help). Guard, then try/catch the race.
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime
        .sendMessage({
          kind: 'capture',
          platform: msg.platform,
          type: msg.type,
          payload: msg.payload,
        })
        .catch(() => {
          // Background asleep/reloading; capture re-fires on next trigger.
        });
    } catch (_) {
      // Context invalidated between the guard and the call — ignore.
    }
  });
})();
