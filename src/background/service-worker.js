// Background service worker — receives captured conversations, normalizes them
// to the common ConversationModel, diffs by message id against locally-seen ids,
// and logs what we WOULD write to Notion.
//
// When Notion is configured (chrome.storage has notionToken + notionRootPageId),
// fresh messages are written to Notion and marked synced ONLY after a durable
// write. When NOT configured, we fall back to M1 behavior (mark seen immediately)
// so the diff stays observable.
// To reset the demo, open this worker's DevTools console and run:
//     chrome.storage.local.clear()

import { syncConversation, getConfig } from './notion.js';

// ---- Claude normalize (per-platform; will move into an adapter later) --------
function collectFiles(m) {
  const out = [];
  const push = (arr, kind) => {
    if (Array.isArray(arr)) {
      for (const f of arr) {
        out.push({ name: f.file_name || f.name || f.title || '(file)', kind });
      }
    }
  };
  push(m.attachments, 'attachment');
  push(m.files, 'file');
  push(m.files_v2, 'file');
  return out;
}

function normalizeClaude(raw) {
  const messages = (raw.chat_messages || []).map((m) => {
    const role = m.sender === 'human' ? 'human' : 'assistant';
    const content = Array.isArray(m.content) ? m.content : [];

    // Preserve the ORIGINAL order of content parts so tool calls / thinking land
    // in their real position relative to the answer (Claude orders content[] as
    // thinking → tool_use → tool_result → text as they actually happened).
    const segments = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) segments.push({ kind: 'text', text: c.text });
      else if (c.type === 'thinking') segments.push({ kind: 'thinking', text: c.thinking || c.text || '' });
      else if (c.type === 'tool_use') segments.push({ kind: 'tool_use', name: c.name, input: c.input });
      else if (c.type === 'tool_result') segments.push({ kind: 'tool_result', name: c.name, result: c.content });
    }
    if (!segments.length && m.text) segments.push({ kind: 'text', text: m.text }); // older shapes

    return {
      id: m.uuid,
      role,
      createdAt: m.created_at,
      segments,
      // Derived views for the console preview (order doesn't matter here).
      text: segments.filter((s) => s.kind === 'text').map((s) => s.text).join(''),
      thinking: segments.filter((s) => s.kind === 'thinking').map((s) => s.text),
      tools: segments.filter((s) => s.kind === 'tool_use' || s.kind === 'tool_result'),
      files: collectFiles(m),
    };
  });

  return {
    id: raw.uuid,
    platform: 'claude',
    title: raw.name || '(untitled)',
    url: `https://claude.ai/chat/${raw.uuid}`,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    messages,
  };
}

const NORMALIZERS = { claude: normalizeClaude };

// ---- diff + log --------------------------------------------------------------
function preview(text, n = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function handleConversation(platform, raw) {
  const normalize = NORMALIZERS[platform];
  if (!normalize) return;
  const conv = normalize(raw);

  const key = `synced:${conv.platform}:${conv.id}`;
  const stored = (await chrome.storage.local.get(key))[key] || { messageIds: [] };
  const seen = new Set(stored.messageIds);
  const fresh = conv.messages.filter((m) => !seen.has(m.id));
  const turns = conv.messages.filter((m) => m.role === 'assistant').length;

  console.groupCollapsed(
    `%c[ACNS] ${conv.platform} · ${conv.title}`,
    'color:#7c6cff;font-weight:bold'
  );
  console.log('conversation id :', conv.id);
  console.log('messages total  :', conv.messages.length);
  console.log('already seen    :', seen.size);
  console.log('NEW this capture:', fresh.length);
  console.log('turns (AI 答完) :', turns);
  for (const m of fresh) {
    const tags = [
      m.thinking.length ? `thinking×${m.thinking.length}` : '',
      m.tools.length ? `tools×${m.tools.length}` : '',
      m.files.length ? `files:[${m.files.map((f) => f.name).join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`  + [${m.role}] ${preview(m.text)}${tags ? '  ' + tags : ''}`);
  }
  console.groupEnd();

  if (!fresh.length) return;

  const cfg = await getConfig();
  const markSynced = async (ids) => {
    const messageIds = [...seen, ...ids];
    await chrome.storage.local.set({ [key]: { messageIds, title: conv.title } });
  };

  if (!cfg) {
    // Notion not configured → do NOT mark synced (that would falsely record
    // messages as written and they'd never sync once configured). Just report.
    console.log('[ACNS] Notion not configured — set credentials to write. (not marking synced)');
    return;
  }

  try {
    const { pageId, newlySynced } = await syncConversation(conv, seen);
    // Mark synced only after a durable write; partial progress is preserved.
    if (newlySynced.length) await markSynced(newlySynced);
    console.log(`%c[ACNS] → Notion ✓ wrote ${newlySynced.length} message(s) to page ${pageId}`,
      'color:#10b981');
  } catch (e) {
    console.warn('[ACNS] Notion write failed (will retry next trigger):', e.message);
  }
}

// ---- message intake ----------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
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
