// Notion writer — runs in the background service worker.
//
// Responsibilities:
//  - Read token + root page id from chrome.storage (entered manually for now).
//  - Ensure structure: root page → "Claude" page → "Claude Conversations" db
//    (ids cached in chrome.storage so we don't recreate them).
//  - Upsert one row-page per conversation, keyed by the "Conversation ID"
//    property (idempotent across devices / reinstalls).
//  - Append fresh messages as blocks, respecting Notion API limits.
//
// M2 scope: conversation body is written as plain-text paragraphs (no full
// markdown→blocks fidelity yet — that needs a bundler). Speaker is shown via a
// colored callout label; thinking / tool calls go into toggles.

import { LOCAL_NOTION } from './local-config.js';
import { markdownToBlocks } from '@tryfabric/martian';

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

const DB_NAME = 'Claude Conversations';
const PLATFORM_PAGE = 'Claude';

// Property names (Chinese, per design). Centralized so a rename is one edit.
const PROP = {
  title: '标题',
  date: '时间',
  turns: '轮次',
  url: '会话链接',
  convId: 'Conversation ID',
};

// ---- low-level fetch with rate-limit handling ------------------------------
async function napi(token, path, method = 'GET', body) {
  const url = path.startsWith('http') ? path : `${NOTION}${path}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': VERSION,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Network/CORS failures surface as TypeError("Failed to fetch").
      throw new Error(
        `[notion] request failed (network/CORS?) for ${method} ${path}: ${e.message}. ` +
        `If this persists, the extension may need a relay (see requirements §7.3).`
      );
    }
    if (res.status === 429) {
      const wait = (parseInt(res.headers.get('Retry-After') || '1', 10) || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(`[notion] ${res.status} ${method} ${path}: ${data.message || text}`);
    }
    return data;
  }
  throw new Error(`[notion] gave up after retries: ${method} ${path}`);
}

// ---- config ----------------------------------------------------------------
// Prefer the gitignored local-config.js (optional dev hardcode), else
// chrome.storage (set via the settings page). local-config.js is a static import
// because the bundle inlines it; build.mjs auto-creates an empty stub if missing.
export async function getConfig() {
  if (LOCAL_NOTION?.token && LOCAL_NOTION?.rootPageId) return LOCAL_NOTION;

  const { notionToken, notionRootPageId } = await chrome.storage.local.get([
    'notionToken',
    'notionRootPageId',
  ]);
  if (!notionToken || !notionRootPageId) return null;
  return { token: notionToken, rootPageId: notionRootPageId };
}

// ---- structure (cached) ----------------------------------------------------
async function ensureStructure(cfg) {
  const cacheKey = `notionStruct:${cfg.rootPageId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached?.dbId) return cached;

  // Verify connectivity + token up front with a cheap call.
  await napi(cfg.token, '/users/me');

  const claudePage = await napi(cfg.token, '/pages', 'POST', {
    parent: { type: 'page_id', page_id: cfg.rootPageId },
    properties: { title: { title: [{ text: { content: PLATFORM_PAGE } }] } },
  });

  const db = await napi(cfg.token, '/databases', 'POST', {
    parent: { type: 'page_id', page_id: claudePage.id },
    title: [{ text: { content: DB_NAME } }],
    properties: {
      [PROP.title]: { title: {} },
      [PROP.date]: { date: {} },
      [PROP.turns]: { number: {} },
      [PROP.url]: { url: {} },
      [PROP.convId]: { rich_text: {} },
    },
  });

  const struct = { claudePageId: claudePage.id, dbId: db.id };
  await chrome.storage.local.set({ [cacheKey]: struct });
  return struct;
}

// ---- conversation row (idempotent by Conversation ID) ----------------------
async function upsertConversationRow(cfg, dbId, conv, turns) {
  const props = {
    [PROP.title]: { title: [{ text: { content: conv.title || '(untitled)' } }] },
    [PROP.turns]: { number: turns },
    [PROP.url]: { url: conv.url },
    [PROP.convId]: { rich_text: [{ text: { content: conv.id } }] },
  };
  if (conv.updatedAt) props[PROP.date] = { date: { start: conv.updatedAt } };

  const q = await napi(cfg.token, `/databases/${dbId}/query`, 'POST', {
    filter: { property: PROP.convId, rich_text: { equals: conv.id } },
    page_size: 1,
  });

  if (q.results?.length) {
    const pageId = q.results[0].id;
    await napi(cfg.token, `/pages/${pageId}`, 'PATCH', { properties: props });
    return pageId;
  }
  const page = await napi(cfg.token, '/pages', 'POST', {
    parent: { type: 'database_id', database_id: dbId },
    properties: props,
  });
  return page.id;
}

// ---- block builders --------------------------------------------------------
const MAX_TEXT = 2000;
const MAX_CHILDREN = 100;

function chunk(str, n = MAX_TEXT) {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out.length ? out : [''];
}

function paragraphBlocks(text) {
  const blocks = [];
  for (const para of String(text).split(/\n{2,}/)) {
    const t = para.trim();
    if (!t) continue;
    for (const c of chunk(t)) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: c } }] },
      });
    }
  }
  return blocks;
}

function toggleBlock(label, text) {
  // Toggle children submitted inline → keep within depth 2 and ≤100 children.
  const children = paragraphBlocks(text).slice(0, MAX_CHILDREN);
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: label } }],
      children,
    },
  };
}

function speakerCallout(message) {
  const human = message.role === 'human';
  const when = (message.createdAt || '').slice(0, 16).replace('T', ' ');
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: `${human ? 'You' : 'Claude'}${when ? ' · ' + when : ''}` } }],
      icon: { type: 'emoji', emoji: human ? '🧑' : '🤖' },
      color: human ? 'gray_background' : 'blue_background',
    },
  };
}

function asText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// Render markdown → Notion blocks via martian (headings/lists/code/quotes/bold…).
// martian truncates to Notion limits by default. Fall back to plain paragraphs
// if it ever throws on odd input.
function mdBlocks(text) {
  try {
    const blocks = markdownToBlocks(text, { notionLimits: { truncate: true } });
    return blocks.length ? blocks : paragraphBlocks(text);
  } catch (_) {
    return paragraphBlocks(text);
  }
}

function buildMessageBlocks(message) {
  const blocks = [speakerCallout(message)];
  // Walk segments in original order → tool calls appear before the answer text,
  // matching how the turn actually unfolded.
  const segs = message.segments?.length
    ? message.segments
    : message.text
      ? [{ kind: 'text', text: message.text }]
      : [];
  for (const s of segs) {
    if (s.kind === 'text') blocks.push(...mdBlocks(s.text));
    // thinking / tools stay plain-text inside toggles: martian's nested output
    // could exceed Notion's 2-level depth limit when wrapped in a toggle.
    else if (s.kind === 'thinking') blocks.push(toggleBlock('💭 Thinking', s.text));
    else if (s.kind === 'tool_use')
      blocks.push(toggleBlock(`🔧 Tool: ${s.name || 'unknown'}`, asText(s.input).slice(0, MAX_TEXT * 2)));
    else if (s.kind === 'tool_result')
      blocks.push(toggleBlock(`📥 Result${s.name ? ': ' + s.name : ''}`, asText(s.result).slice(0, MAX_TEXT * 2)));
  }
  return blocks;
}

async function appendInBatches(token, pageId, blocks) {
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN) {
    await napi(token, `/blocks/${pageId}/children`, 'PATCH', {
      children: blocks.slice(i, i + MAX_CHILDREN),
    });
  }
}

// ---- public entry ----------------------------------------------------------
// Writes fresh (not-yet-synced) messages. Returns ids that were successfully
// written, so the caller marks them synced only after a durable write.
export async function syncConversation(conv, alreadySynced) {
  const cfg = await getConfig();
  if (!cfg) {
    const err = new Error('NOT_CONFIGURED');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const turns = conv.messages.filter((m) => m.role === 'assistant').length;
  const { dbId } = await ensureStructure(cfg);
  const pageId = await upsertConversationRow(cfg, dbId, conv, turns);

  const newlySynced = [];
  for (const m of conv.messages) {
    if (alreadySynced.has(m.id)) continue;
    await appendInBatches(cfg.token, pageId, buildMessageBlocks(m));
    newlySynced.push(m.id); // per-message durability boundary
  }
  return { pageId, newlySynced };
}
