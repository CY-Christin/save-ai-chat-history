// MAIN-world injected script — runs in the page's JS context at document_start.
//
// Capture WITHOUT monkey-patching window.fetch/XHR, so we coexist with other
// extensions/userscripts that also hook fetch (e.g. Tampermonkey export tools).
// We only ever ISSUE our own canonical refetch; we never intercept the app's
// request bodies.
//
// Two conflict-free triggers, both ending in "refetch the canonical conversation":
//   1. URL change to a conversation path — open / switch / new→chat / cross-device.
//   2. completion finished — follow-up turns in the SAME conversation, detected
//      via PerformanceObserver on the streaming request's resource timing entry
//      (reads URL + timing only, touches nobody's fetch).
//
// It never touches chrome.* (no access from MAIN world) and only forwards the
// conversation object — never cookies/auth headers.
//
// Per-platform specifics (URL shapes, endpoints, auth) live in the configs
// below; the trigger/debounce/retry engine underneath is shared.

(() => {
  if (window.__acnsInstalled) return;
  window.__acnsInstalled = true;

  const TAG = 'acns';

  // Capture whatever fetch is current — used ONLY to issue our own GETs. We
  // don't care if it's native or someone's wrapper; a plain GET passes through.
  const issueFetch = window.fetch.bind(window);

  // ---- platform capture configs ----------------------------------------------
  // Contract:
  //   hosts            — hostnames this config serves
  //   convIdFromPath   — conversation id from location.pathname, or null
  //   resourceTrigger  — completion resource-entry URL → {convId} (id extractable
  //                      from the URL) or {currentUrl:true} (refetch whatever the
  //                      page shows) or null (not a completion)
  //   fetchConversation— issue the canonical refetch, returns the Response
  //                      (throws for pre-request failures, e.g. missing auth)

  const CLAUDE = {
    id: 'claude',
    hosts: ['claude.ai'],
    // Org resolution order matters for multi-workspace users: the org observed
    // in a completion URL is ground truth FOR THAT conversation (the
    // lastActiveOrg cookie is one shared value and may point at another
    // workspace's tab), so prefer it; cookie covers URL-triggered convs we
    // never saw a completion for.
    orgByConv: new Map(),
    lastOrg: null,
    convIdFromPath(pathname) {
      const m = pathname.match(/\/chat\/([0-9a-fA-F-]{36})/);
      return m ? m[1] : null;
    },
    resourceTrigger(url) {
      const m = url.match(
        /\/api\/organizations\/([0-9a-f-]+)\/chat_conversations\/([0-9a-f-]+)\/(?:completion|retry_completion)/i
      );
      if (!m) return null;
      this.orgByConv.set(m[2], m[1]);
      this.lastOrg = m[1];
      return { convId: m[2] };
    },
    fetchConversation(conv) {
      const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
      const org = this.orgByConv.get(conv) || (m ? decodeURIComponent(m[1]) : this.lastOrg);
      if (!org) throw new Error('org id unavailable (lastActiveOrg cookie missing)');
      return issueFetch(
        `${location.origin}/api/organizations/${org}/chat_conversations/${conv}` +
          `?tree=True&rendering_mode=messages&render_all_tools=true`,
        { credentials: 'include' }
      );
    },
  };

  const CHATGPT = {
    id: 'chatgpt',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    convIdFromPath(pathname) {
      // /c/{uuid} and /g/{gizmo}/c/{uuid} (custom GPTs)
      const m = pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
      return m ? m[1] : null;
    },
    resourceTrigger(url) {
      // The streaming completion endpoint is /backend-api/conversation (or the
      // /f/ variant) with NO id suffix. End-anchor the match so our own
      // GET /backend-api/conversation/{uuid} refetch can never re-trigger.
      try {
        const path = new URL(url).pathname;
        if (/\/backend-api\/(?:f\/)?conversation$/.test(path)) return { currentUrl: true };
      } catch (_) {
        /* not a URL */
      }
      return null;
    },
    async fetchConversation(conv) {
      // backend-api needs a Bearer token; the page gets it from its own
      // session endpoint (cookie-authed), so we do the same two-step.
      const sess = await issueFetch(`${location.origin}/api/auth/session`, {
        credentials: 'include',
      });
      if (!sess.ok) throw new Error(`session fetch failed (${sess.status}) — logged out?`);
      const { accessToken } = await sess.json();
      if (!accessToken) throw new Error('no accessToken in session — logged out?');
      const headers = { Authorization: `Bearer ${accessToken}` };
      // Team/Business workspaces scope backend-api by account: without this
      // header the conversation 404s even with a valid token.
      const acct = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
      if (acct) headers['Chatgpt-Account-Id'] = decodeURIComponent(acct[1]);
      return issueFetch(`${location.origin}/backend-api/conversation/${conv}`, {
        credentials: 'include',
        headers,
      });
    },
  };

  const platform = [CLAUDE, CHATGPT].find((p) =>
    p.hosts.some((h) => location.hostname === h || location.hostname.endsWith('.' + h))
  );
  if (!platform) return;

  // ---- bridge out ------------------------------------------------------------
  function post(type, payload) {
    window.postMessage({ __source: TAG, platform: platform.id, type, payload }, location.origin);
  }

  // ---- canonical refetch (the only network calls we make) --------------------
  const lastRefetch = new Map(); // convId -> ts (debounce bursts of triggers)
  async function refetchConversation(conv, reason) {
    if (!conv) return;
    const now = Date.now();
    // 'force' (popup resync) bypasses the debounce — it may arrive right after
    // a normal trigger and must not be silently swallowed.
    if (!reason.startsWith('force') && now - (lastRefetch.get(conv) || 0) < 1200) return;
    lastRefetch.set(conv, now);
    try {
      console.log(`%c[ACNS] refetch (${reason}) conv=${conv}`, 'color:#7c6cff');
      const res = await platform.fetchConversation(conv);
      if (!res.ok) {
        // New conversations 404 briefly: the URL flips before the server has
        // the conversation ready. Retry once after it settles.
        if (res.status === 404 && !reason.endsWith(':retry')) {
          console.warn(`[ACNS] refetch 404 (${reason}) conv=${conv} → retry in 1.5s`);
          setTimeout(() => refetchConversation(conv, reason + ':retry'), 1500);
        } else {
          console.warn(`[ACNS] refetch FAILED status=${res.status} (${reason}) conv=${conv}`);
          post('error', { stage: 'refetch', status: res.status, conv });
        }
        return;
      }
      let raw;
      try {
        raw = await res.json();
      } catch (_) {
        // 200 but not JSON — logged-out page or a challenge interstitial.
        console.warn(`[ACNS] refetch returned non-JSON (logged out?) conv=${conv}`);
        post('error', { stage: 'refetch', message: 'non-JSON response (logged out?)', conv });
        return;
      }
      console.log(`%c[ACNS] refetch ok (${reason}) conv=${conv} → posting`, 'color:#10b981');
      post('conversation', { source: reason, raw });
    } catch (e) {
      // A throw means no conversation data was fetched (missing auth, network
      // down). Free the debounce slot so the next trigger isn't swallowed.
      lastRefetch.delete(conv);
      post('error', { stage: 'refetch', message: String(e), conv });
    }
  }
  function triggerForCurrentUrl(reason) {
    const conv = platform.convIdFromPath(location.pathname);
    if (conv) refetchConversation(conv, reason);
  }

  // ---- Trigger 1: URL becomes a conversation path ----------------------------
  const _push = history.pushState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    queueMicrotask(() => triggerForCurrentUrl('url:push'));
    return r;
  };
  const _replace = history.replaceState;
  history.replaceState = function () {
    const r = _replace.apply(this, arguments);
    queueMicrotask(() => triggerForCurrentUrl('url:replace'));
    return r;
  };
  window.addEventListener('popstate', () => triggerForCurrentUrl('url:popstate'));

  // Fallback poll for navigations the history hooks miss.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      triggerForCurrentUrl('url:poll');
    }
  }, 1000);

  // Initial load (covers hard-loading a conversation URL directly).
  triggerForCurrentUrl('initial');

  // Control channel: popup → background → bridge → here (force resync).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__source !== `${TAG}-ctl`) return;
    if (msg.type === 'refetch') triggerForCurrentUrl('force');
  });

  // ---- Trigger 2: completion finished ----------------------------------------
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const t = platform.resourceTrigger(String(e.name || ''));
        if (!t) continue;
        console.log('%c[ACNS] completion observed → refetch', 'color:#10b981');
        if (t.convId) refetchConversation(t.convId, 'completion');
        else triggerForCurrentUrl('completion');
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {
    console.warn('[ACNS] PerformanceObserver unavailable', e);
  }

  console.log(
    `%c[ACNS] capture installed (${platform.id}: URL + PerformanceObserver, no fetch patch)`,
    'color:#7c6cff;font-weight:bold'
  );
})();
