// Background service worker — receives captured conversations, normalizes them
// to the common ConversationModel, then fans out to every ENABLED sink (landing
// channel). Each sink diffs by message id against its own per-sink synced state
// and messages are marked synced ONLY after a durable write.
//
// To reset, open this worker's DevTools console and run:
//     chrome.storage.local.clear()

import { SINKS } from '../sinks/registry.js';
import { getSinkSettings, isConfigComplete } from './sink-settings.js';
import { LOCAL_NOTION } from './local-config.js';

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

function messageTags(m) {
  return [
    m.thinking.length ? `thinking×${m.thinking.length}` : '',
    m.tools.length ? `tools×${m.tools.length}` : '',
    m.files.length ? `files:[${m.files.map((f) => f.name).join(', ')}]` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function handleConversation(platform, raw) {
  const normalize = NORMALIZERS[platform];
  if (!normalize) return;
  const conv = normalize(raw);
  const turns = conv.messages.filter((m) => m.role === 'assistant').length;

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
      const { newlySynced, ref } = await sink.sync(config, conv, seen);
      if (newlySynced?.length) {
        await chrome.storage.local.set({
          [key]: { messageIds: [...seen, ...newlySynced], title: conv.title },
        });
      }
      console.log(
        `%c→ ${sink.id} ✓ wrote ${newlySynced?.length || 0} msg${ref ? ' → ' + ref : ''}`,
        'color:#10b981'
      );
    } catch (e) {
      console.warn(`→ ${sink.id} failed (will retry next trigger):`, e.message);
    }
  }
  console.groupEnd();
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
