// Background service worker — receives captured conversations, normalizes them
// to the common ConversationModel, then fans out to every ENABLED sink (sync
// target). Each sink diffs by message id against its own per-sink synced state
// and messages are marked synced ONLY after a durable write.
//
// To reset, open this worker's DevTools console and run:
//     chrome.storage.local.clear()

import { SINKS } from '../sinks/registry.js';
import { getSinkSettings, isConfigComplete } from './sink-settings.js';
import { normalizeClaude } from './normalize/claude.js';
import { normalizeChatGPT } from './normalize/chatgpt.js';
import { conversationHeader, messagesToMarkdown } from '../lib/markdown.js';
import { platformLabel } from '../lib/platform.js';
import { getCaptureSettings, EXTERNALIZE_MIN_MB } from './capture-settings.js';

// Resolve which sinks to run: those explicitly enabled with complete config in
// settings.
async function getActiveSinks() {
  const settings = await getSinkSettings();
  const active = [];
  for (const sink of SINKS) {
    const setting = settings[sink.id];
    if (setting?.enabled) {
      if (isConfigComplete(sink, setting.config)) active.push({ sink, config: setting.config });
      else console.log(`[ACNS] sink ${sink.id} enabled but config incomplete — skipped`);
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
  const pending = pendingExports.get(conv.id);
  if (pending) {
    pendingExports.delete(conv.id);
    pending.resolve(conv);
  }
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

// ---- export (popup) -----------------------------------------------------------
// Ask the tab to refetch, wait for that capture to land here, render it with the
// same markdown pipeline the Cloudflare sink uses, and hand the result back for
// the popup to download. Two shapes:
//   kind 'md'  — one self-contained .md, file contents inlined
//   kind 'zip' — .md referencing files by relative link + the files as separate
//                entries (popup zips them); keeps the md readable when uploads
//                are large
// zip is used when the capture cap admits big files (≥2MB) AND the settings-page
// 外置文件 checkbox is on AND the conversation actually has file contents;
// otherwise a single .md. Independent of sink config on purpose: export works
// with zero sinks enabled.
const pendingExports = new Map(); // convId → { resolve }

async function exportConversation({ convId, tabId }) {
  const conv = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingExports.delete(convId);
      reject(new Error('页面未响应 — 刷新该对话页后重试'));
    }, 10000);
    pendingExports.set(convId, {
      resolve: (c) => {
        clearTimeout(timer);
        resolve(c);
      },
    });
    chrome.tabs.sendMessage(tabId, { kind: 'control', type: 'refetch' }).catch(() => {
      clearTimeout(timer);
      pendingExports.delete(convId);
      reject(new Error('页面未响应 — 刷新该对话页后重试'));
    });
  });

  const who = platformLabel(conv.platform);
  const withContent = conv.messages.flatMap((m) => (m.files || []).filter((f) => f.content));

  const capture = await getCaptureSettings();
  const kind =
    capture.blobMaxMB >= EXTERNALIZE_MIN_MB &&
    capture.externalizeFiles !== false &&
    withContent.length
      ? 'zip'
      : 'md';

  if (kind === 'md') {
    const md =
      conversationHeader(conv) + '\n' + messagesToMarkdown(conv.messages, null, who);
    return { ok: true, kind, md, title: conv.title };
  }

  // zip: files land under files/ with collision-safe names; md links to them.
  const used = new Set();
  const stored = new Map(); // file ref → stored name
  for (const f of withContent) {
    const base = f.name || 'file';
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${stem} (${i})${ext}`;
    used.add(name);
    stored.set(f, name);
  }
  const fileUrlFor = (f) => (stored.has(f) ? 'files/' + encodeURI(stored.get(f)) : null);
  const md =
    conversationHeader(conv) + '\n' + messagesToMarkdown(conv.messages, fileUrlFor, who);
  return {
    ok: true,
    kind,
    md,
    title: conv.title,
    files: withContent.map((f) => ({ name: stored.get(f), content: f.content })),
  };
}

// ---- message intake ----------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'control' && msg.type === 'forceResync') {
    forceResync(msg).then(sendResponse, (e) => sendResponse({ ok: false, message: e.message }));
    return true; // async response
  }
  if (msg?.kind === 'control' && msg.type === 'export') {
    exportConversation(msg).then(sendResponse, (e) =>
      sendResponse({ ok: false, message: e.message })
    );
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
