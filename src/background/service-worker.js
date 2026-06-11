// Background service worker — receives captured conversations, normalizes them
// to the common ConversationModel, then fans out to every ENABLED sink (sync
// target). Each sink diffs by message id against its own per-sink synced state
// and messages are marked synced ONLY after a durable write.
//
// To reset, open this worker's DevTools console and run:
//     chrome.storage.local.clear()

import { SINKS } from '../sinks/registry.js';
import { getSinkSettings, isConfigComplete } from './sink-settings.js';
import { LOCAL_NOTION } from './local-config.js';
import { normalizeClaude } from './normalize/claude.js';
import { normalizeChatGPT } from './normalize/chatgpt.js';

// Resolve which sinks to run: those explicitly enabled with complete config in
// settings, plus a dev fallback — if Notion was never configured in settings but
// local-config.js has values, run it (so hardcoded dev creds keep working).
async function getActiveSinks() {
  const settings = await getSinkSettings();
  const active = [];
  for (const sink of SINKS) {
    const setting = settings[sink.id];
    if (setting?.enabled) {
      if (isConfigComplete(sink, setting.config)) active.push({ sink, config: setting.config });
      else console.log(`[ACNS] sink ${sink.id} enabled but config incomplete — skipped`);
    } else if (!setting && sink.id === 'notion' && LOCAL_NOTION?.token && LOCAL_NOTION?.rootPageId) {
      active.push({ sink, config: LOCAL_NOTION });
    }
  }
  return active;
}

// Per-platform raw → ConversationModel normalizers live in ./normalize/.
const NORMALIZERS = { claude: normalizeClaude, chatgpt: normalizeChatGPT };

// ---- diff + log --------------------------------------------------------------
function preview(text, n = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function messageTags(m) {
  return [
    m.thinking.length ? `thinking×${m.thinking.length}` : '',
    m.tools.length ? `tools×${m.tools.length}` : '',
    m.files.length
      ? `files:[${m.files
          .map((f) => `${f.name}<${f.source},${f.content ? f.content.length + 'ch' : 'NO-CONTENT'}>`)
          .join(', ')}]`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const convLocks = new Map(); // convId → tail promise

// Run fn after any in-flight work for this conversation finishes. Different
// conversations use different locks, so they still run in parallel; only
// overlapping triggers for the SAME conversation (e.g. completion + URL switch)
// are serialized — preventing a sink's read-modify-write from racing itself.
function withConvLock(convId, fn) {
  const next = (convLocks.get(convId) || Promise.resolve()).then(fn, fn);
  convLocks.set(convId, next.catch(() => {}));
  return next;
}

async function handleConversation(platform, raw) {
  const normalize = NORMALIZERS[platform];
  if (!normalize) return;
  const conv = normalize(raw);
  return withConvLock(conv.id, () => runConversationSync(conv));
}

async function runConversationSync(conv) {
  const turns = conv.turns ?? conv.messages.filter((m) => m.role === 'assistant').length;

  console.groupCollapsed(
    `%c[ACNS] ${conv.platform} · ${conv.title}`,
    'color:#7c6cff;font-weight:bold'
  );
  console.log('conversation id :', conv.id);
  console.log('messages total  :', conv.messages.length);
  console.log('turns (AI 答完) :', turns);

  const active = await getActiveSinks();
  if (!active.length) {
    console.log('no sink enabled — configure one in the settings page.');
    console.groupEnd();
    return;
  }

  // Fan out to each sink with its OWN per-sink synced state. Mark synced only
  // after a durable write, so a failed sink retries on the next trigger.
  for (const { sink, config } of active) {
    const key = `synced:${sink.id}:${conv.platform}:${conv.id}`;
    const stored = (await chrome.storage.local.get(key))[key] || { messageIds: [] };
    const seen = new Set(stored.messageIds);
    const fresh = conv.messages.filter((m) => !seen.has(m.id));

    if (!fresh.length) {
      console.log(`${sink.id}: up to date (0 new)`);
      continue;
    }
    console.groupCollapsed(`${sink.id}: ${fresh.length} new`);
    for (const m of fresh) {
      const tags = messageTags(m);
      console.log(`  + [${m.role}] ${preview(m.text)}${tags ? '  ' + tags : ''}`);
    }
    console.groupEnd();

    try {
      const { newlySynced, ref, error } = await sink.sync(config, conv, seen);
      // Mark whatever durably landed — even on a partial failure — so a long
      // backfill resumes where it stopped instead of re-writing (= duplicating).
      if (newlySynced?.length) {
        await chrome.storage.local.set({
          [key]: { messageIds: [...seen, ...newlySynced], title: conv.title },
        });
      }
      if (error) {
        console.warn(
          `→ ${sink.id} partial: wrote ${newlySynced?.length || 0} msg, then failed (rest retries next trigger):`,
          error.message
        );
      } else {
        console.log(
          `%c→ ${sink.id} ✓ wrote ${newlySynced?.length || 0} msg${ref ? ' → ' + ref : ''}`,
          'color:#10b981'
        );
      }
    } catch (e) {
      console.warn(`→ ${sink.id} failed (will retry next trigger):`, e.message);
    }
  }
  console.groupEnd();
}

// ---- force resync (popup) ------------------------------------------------ --
// Clear this conversation's synced state for every sink, then ask the tab to
// refetch. The empty synced set makes each sink do its "first sync = clean
// rewrite" path (Notion archives+rebuilds the row, Cloudflare PUTs the full md),
// so a re-sync can't duplicate content.
async function forceResync({ platform, convId, tabId }) {
  const active = await getActiveSinks();
  if (!active.length) return { ok: false, message: '没有启用任何同步目标 — 先到设置页配置' };

  // Inside the lock so we can't clear keys while a sync of this conversation is
  // mid-write (it would re-add them at the end and the resync would be partial).
  await withConvLock(convId, async () => {
    const keys = SINKS.map((s) => `synced:${s.id}:${platform}:${convId}`);
    await chrome.storage.local.remove(keys);
  });

  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'control', type: 'refetch' });
  } catch (_) {
    // No content script in the tab (extension was reloaded?). State is already
    // cleared, so any future trigger rewrites everything — just tell the user.
    return { ok: true, message: '已清除同步状态，但页面未响应 — 刷新该对话页即可重新同步' };
  }
  return { ok: true, message: '已触发重新同步（Notion 旧页面会归档重建）' };
}

// ---- message intake ----------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'control' && msg.type === 'forceResync') {
    forceResync(msg).then(sendResponse, (e) => sendResponse({ ok: false, message: e.message }));
    return true; // async response
  }
  if (!msg || msg.kind !== 'capture') return;
  if (msg.type === 'conversation' && msg.payload && msg.payload.raw) {
    console.log(`[ACNS] recv conversation (source=${msg.payload.source})`);
    handleConversation(msg.platform, msg.payload.raw).catch((e) =>
      console.warn('[ACNS] handle error', e)
    );
  } else if (msg.type === 'error') {
    console.warn('[ACNS] capture error', msg.payload);
  }
  // No async response needed.
});

console.log('[ACNS] background ready');
