// Notion sink — one of the pluggable sync targets (see sinks/registry.js).
//
// Implements the sink contract: { id, name, configFields, sync(config, conv,
// alreadySynced) → { newlySynced, ref } }. Config (token + root page id) is
// passed in by the caller (resolved from chrome.storage / settings page), not
// read here.
//
// Behavior: ensure structure (root page → per-platform page, e.g. "Claude" →
// "Claude Conversations" db, ids cached per platform), upsert one row-page per
// conversation keyed by "Conversation ID" (idempotent), then append fresh
// messages as blocks (markdown via martian), respecting Notion API limits.

import { markdownToBlocks } from '@tryfabric/martian';
import { platformLabel } from '../lib/platform.js';

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

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
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        // Gateway/HTML error page instead of JSON — surface a readable snippet.
        data = { message: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const err = new Error(`[notion] ${res.status} ${method} ${path}: ${data.message || text}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error(`[notion] gave up after retries: ${method} ${path}`);
}

// ---- structure (cached) ----------------------------------------------------
// List all child blocks of a page (handles pagination).
async function listChildren(token, blockId) {
  const out = [];
  let cursor = null;
  do {
    const qs = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data = await napi(token, `/blocks/${blockId}/children${qs}`);
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

// Find an existing child page / database by exact title (returns its id or null).
// Trashed items don't appear in children, so this naturally ignores deleted ones.
async function findChildByTitle(token, parentId, type, title) {
  const children = await listChildren(token, parentId);
  const hit = children.find((b) => b.type === type && b[type]?.title === title);
  return hit?.id || null;
}

// Ensure root → platform page (e.g. "Claude") → "<Platform> Conversations" db
// exist. Source of truth is Notion's ACTUAL content: we look up existing items
// by title and reuse them, creating only what's missing — so a stale cache, a
// renamed/recreated structure, or a user-deleted db can't cause duplicates.
// The cache is only a fast path, keyed per platform.
async function ensureStructure(cfg, platform) {
  const pageName = platformLabel(platform);
  const dbName = `${pageName} Conversations`;
  const cacheKey = `notionStruct:${cfg.rootPageId}:${platform}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];

  // Fast path: cached db still live (not deleted/trashed) → use it as-is.
  if (cached?.dbId) {
    try {
      const db = await napi(cfg.token, `/databases/${cached.dbId}`);
      if (!db.archived && !db.in_trash) return cached;
    } catch (e) {
      if (e.status !== 404) throw e; // 404 → fall through to discovery
    }
  }

  // Migration: pre-multi-platform versions cached under notionStruct:{root}
  // (claude only). Adopt that db if still live — title discovery below would
  // miss a RENAMED page/db and create a duplicate structure beside it.
  if (platform === 'claude' && !cached) {
    const legacyKey = `notionStruct:${cfg.rootPageId}`;
    const legacy = (await chrome.storage.local.get(legacyKey))[legacyKey];
    if (legacy?.dbId) {
      try {
        const db = await napi(cfg.token, `/databases/${legacy.dbId}`);
        if (!db.archived && !db.in_trash) {
          const struct = { platformPageId: legacy.claudePageId, dbId: legacy.dbId };
          await chrome.storage.local.set({ [cacheKey]: struct });
          await chrome.storage.local.remove(legacyKey);
          return struct;
        }
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      await chrome.storage.local.remove(legacyKey); // dead — clean up
    }
  }

  // Slow path: discover by title, create only what's missing.
  await napi(cfg.token, '/users/me'); // connectivity + token check

  let platformPageId = await findChildByTitle(cfg.token, cfg.rootPageId, 'child_page', pageName);
  if (!platformPageId) {
    const page = await napi(cfg.token, '/pages', 'POST', {
      parent: { type: 'page_id', page_id: cfg.rootPageId },
      properties: { title: { title: [{ text: { content: pageName } }] } },
    });
    platformPageId = page.id;
  }

  let dbId = await findChildByTitle(cfg.token, platformPageId, 'child_database', dbName);
  if (!dbId) {
    const db = await napi(cfg.token, '/databases', 'POST', {
      parent: { type: 'page_id', page_id: platformPageId },
      title: [{ text: { content: dbName } }],
      properties: {
        [PROP.title]: { title: {} },
        [PROP.date]: { date: {} },
        [PROP.turns]: { number: {} },
        [PROP.url]: { url: {} },
        [PROP.convId]: { rich_text: {} },
      },
    });
    dbId = db.id;
  }

  const struct = { platformPageId, dbId };
  await chrome.storage.local.set({ [cacheKey]: struct });
  return struct;
}

// ---- conversation row (idempotent by Conversation ID) ----------------------
// isFirst = the local synced set is EMPTY for this conversation. If a row still
// exists in Notion (state cleared, force resync, another device), appending all
// messages again would duplicate every block — so on first sync we archive the
// old row(s) and rebuild. Same semantics as the cloudflare sink's full PUT:
// "first sync is a clean rewrite". Archived pages stay recoverable from trash.
async function upsertConversationRow(cfg, dbId, conv, turns, isFirst) {
  const props = {
    [PROP.title]: { title: [{ text: { content: conv.title || '(untitled)' } }] },
    [PROP.turns]: { number: turns },
    [PROP.url]: { url: conv.url },
    [PROP.convId]: { rich_text: [{ text: { content: conv.id } }] },
  };
  if (conv.updatedAt) props[PROP.date] = { date: { start: conv.updatedAt } };

  const q = await napi(cfg.token, `/databases/${dbId}/query`, 'POST', {
    filter: { property: PROP.convId, rich_text: { equals: conv.id } },
    page_size: 5,
  });

  if (q.results?.length) {
    if (!isFirst) {
      const pageId = q.results[0].id;
      await napi(cfg.token, `/pages/${pageId}`, 'PATCH', { properties: props });
      return pageId;
    }
    // Empty row (no content blocks yet) → reuse it instead of archiving.
    // Otherwise a persistent failure on the very first message write would
    // archive + recreate the row on EVERY trigger (row churn in the trash).
    const probe = await napi(cfg.token, `/blocks/${q.results[0].id}/children?page_size=1`);
    if (!(probe.results || []).length) {
      const pageId = q.results[0].id;
      await napi(cfg.token, `/pages/${pageId}`, 'PATCH', { properties: props });
      return pageId;
    }
    for (const row of q.results) {
      await napi(cfg.token, `/pages/${row.id}`, 'PATCH', { archived: true });
    }
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

function speakerCallout(message, assistantName) {
  const human = message.role === 'human';
  const when = (message.createdAt || '').slice(0, 16).replace('T', ' ');
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: `${human ? 'You' : assistantName}${when ? ' · ' + when : ''}` } }],
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

function buildMessageBlocks(message, assistantName) {
  const blocks = [speakerCallout(message, assistantName)];
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

// Create a child page (under the conversation page) holding a file's markdown.
// Created right after its message body is appended, so Notion places it in the
// conversation flow at the correct position — no extra back-link needed.
async function createFileChildPage(token, parentPageId, file) {
  const page = await napi(token, '/pages', 'POST', {
    parent: { type: 'page_id', page_id: parentPageId },
    properties: { title: { title: [{ text: { content: file.name || '(file)' } }] } },
  });
  await appendInBatches(token, page.id, mdBlocks(file.content));
  return page.id;
}

// ---- sink ------------------------------------------------------------------
// Writes fresh (not-yet-synced) messages. Returns ids that were successfully
// written, so the caller marks them synced only after a durable write. On a
// mid-conversation failure (rate-limit budget exhausted, 5xx) it returns the
// ids that DID land plus the error, instead of throwing — so a long backfill
// resumes where it stopped rather than re-appending (= duplicating) everything.
async function sync(config, conv, alreadySynced) {
  const turns = conv.turns ?? conv.messages.filter((m) => m.role === 'assistant').length;
  const isFirst = alreadySynced.size === 0;
  const assistantName = platformLabel(conv.platform);
  const { dbId } = await ensureStructure(config, conv.platform);
  const pageId = await upsertConversationRow(config, dbId, conv, turns, isFirst);

  const newlySynced = [];
  for (const m of conv.messages) {
    if (alreadySynced.has(m.id)) continue;
    try {
      await appendInBatches(config.token, pageId, buildMessageBlocks(m, assistantName));
      // md files → child pages, appended right after this message's body.
      for (const f of m.files || []) {
        if (f.content) await createFileChildPage(config.token, pageId, f);
      }
    } catch (error) {
      // 400 = Notion rejected the content itself (e.g. a link URL it considers
      // invalid) — retrying identical blocks would stall this conversation
      // forever. Degrade ONCE to plain paragraphs so the message lands and the
      // rest of the conversation keeps flowing. (If an earlier batch of this
      // message already landed, a few blocks duplicate — messy beats stuck.)
      if (error.status === 400) {
        try {
          const plain = [
            speakerCallout(m, assistantName),
            ...paragraphBlocks(m.text || '(此消息内容被 Notion 拒绝，已降级为纯文本仍失败)'),
          ];
          await appendInBatches(config.token, pageId, plain);
          console.warn(`[notion] message ${m.id} degraded to plain text (Notion rejected rich blocks)`);
          newlySynced.push(m.id);
          continue;
        } catch (_) {
          /* degraded write failed too — fall through to partial return */
        }
      }
      return { newlySynced, ref: pageId, error };
    }
    newlySynced.push(m.id); // per-message durability boundary
  }
  return { newlySynced, ref: pageId };
}

// ---- settings-page「测试连接」 ------------------------------------------------
async function testConnection(config) {
  try {
    await napi(config.token, '/users/me');
  } catch (e) {
    return {
      ok: false,
      message: e.status === 401 ? 'Token 无效（401）' : `Token 校验失败：${e.message}`,
    };
  }
  try {
    const page = await napi(config.token, `/pages/${config.rootPageId}`);
    if (page.archived || page.in_trash) {
      return { ok: false, message: '根页面在回收站中，请恢复它或换一个页面' };
    }
    const title =
      page.properties?.title?.title?.map((t) => t.plain_text).join('') || '(untitled)';
    return { ok: true, message: `连接成功 → 「${title}」` };
  } catch (e) {
    return {
      ok: false,
      message:
        e.status === 404
          ? '找不到根页面：ID 不对，或没把 integration 加进该页面的 Connections'
          : `页面校验失败：${e.message}`,
    };
  }
}

// Accept what users actually paste: the full page URL, a dashed UUID, or the
// bare 32-hex id — normalize all of them to the bare id. Unrecognized input is
// returned as-is (the「测试连接」button will then say what's wrong).
function normalizeRootPageId(v) {
  v = String(v || '').replace(/\s+/g, '');
  try {
    if (/^https?:\/\//i.test(v)) {
      const runs = new URL(v).pathname.match(/[0-9a-f]{32}/gi);
      if (runs) return runs[runs.length - 1].toLowerCase();
    }
  } catch (_) {
    /* not a URL — fall through */
  }
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v)) {
    return v.replace(/-/g, '').toLowerCase();
  }
  return v;
}

const stripWhitespace = (v) => String(v || '').replace(/\s+/g, '');

export const notionSink = {
  id: 'notion',
  name: 'Notion',
  configFields: [
    {
      key: 'token',
      label: 'Integration Token',
      type: 'password',
      placeholder: 'ntn_...',
      required: true,
      normalize: stripWhitespace,
      help: '在 notion.so/my-integrations 建 Internal integration 获取',
    },
    {
      key: 'rootPageId',
      label: 'Root Page ID',
      type: 'text',
      placeholder: '页面 URL 或 32 位十六进制 ID 均可',
      required: true,
      normalize: normalizeRootPageId,
      help: '先把 integration 加到该 page 的 Connections 授权；直接粘贴页面 URL 会自动提取 ID',
    },
  ],
  sync,
  testConnection,
};
