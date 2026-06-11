// Cloudflare sink — pushes each conversation as raw markdown to the Worker
// (see worker/), giving a stable URL an AI can fetch. Implements the sink
// contract { id, name, configFields, sync }.
//
// Strategy mirrors Notion's message-id diff, but lands as markdown:
//  - first sync / reset (alreadySynced empty) → full document via PUT (overwrite,
//    so a re-sync can't duplicate),
//  - incremental turns → only fresh messages via POST (server-side append).

import { conversationHeader, messagesToMarkdown } from '../lib/markdown.js';
import { platformLabel } from '../lib/platform.js';

async function send(url, method, token, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown' },
    body,
  });
  if (!res.ok) {
    const err = new Error(`[cloudflare] ${res.status} ${method} ${url}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
}

async function sync(config, conv, alreadySynced) {
  const base = String(config.workerUrl).replace(/\/+$/, '');
  const url = `${base}/conv/${conv.id}`;

  const fresh = conv.messages.filter((m) => !alreadySynced.has(m.id));
  if (!fresh.length) return { newlySynced: [], ref: url };

  const isFirst = alreadySynced.size === 0;

  // Files are stored as SEPARATE docs under the conversation's folder, e.g.
  // /conv/{convId}/files/f0. Assign each file a stable index by its order across
  // the whole conversation, so links don't shift between syncs (PUT overwrites).
  const fileUrlMap = new Map();
  let idx = 0;
  for (const m of conv.messages) {
    for (const f of m.files || []) {
      if (f.content) fileUrlMap.set(f, `${base}/conv/${conv.id}/files/f${idx++}`);
    }
  }
  const fileUrlFor = (f) => fileUrlMap.get(f) || null;

  // PUT is idempotent (same index → same key → same content), so re-uploading
  // a file that already exists is harmless.
  const uploadFiles = async (messages) => {
    for (const m of messages) {
      for (const f of m.files || []) {
        if (f.content) await send(fileUrlMap.get(f), 'PUT', config.writeToken, f.content);
      }
    }
  };
  const who = platformLabel(conv.platform);
  const fullMd = () =>
    conversationHeader(conv) + '\n' + messagesToMarkdown(conv.messages, fileUrlFor, who);

  if (isFirst) {
    await uploadFiles(conv.messages);
    await send(url, 'PUT', config.writeToken, fullMd());
  } else {
    await uploadFiles(fresh);
    try {
      await send(url, 'POST', config.writeToken, '\n' + messagesToMarkdown(fresh, fileUrlFor, who));
    } catch (e) {
      // 404 = the object vanished (deleted from R2) while local state says
      // synced. Self-heal: rewrite the whole document (and all its files —
      // the folder may be gone entirely) instead of appending into a void.
      if (e.status !== 404) throw e;
      await uploadFiles(conv.messages);
      await send(url, 'PUT', config.writeToken, fullMd());
    }
  }
  return { newlySynced: fresh.map((m) => m.id), ref: url };
}

// ---- settings-page「测试连接」 ------------------------------------------------
async function testConnection(config) {
  const base = String(config.workerUrl || '').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/auth-check`, {
      headers: { Authorization: `Bearer ${config.writeToken}` },
    });
  } catch (e) {
    return { ok: false, message: `Worker 无法访问：${e.message}` };
  }
  if (res.status === 204) return { ok: true, message: '连接成功，Write Token 有效' };
  if (res.status === 401) {
    return { ok: false, message: 'Write Token 不匹配（401），与 worker 的 WRITE_TOKEN secret 核对' };
  }
  if (res.status === 404) {
    return { ok: false, message: 'Worker 缺少 /auth-check 路由 — 用最新 worker/ 代码重新部署' };
  }
  return { ok: false, message: `异常响应 ${res.status}` };
}

// Fix what users actually paste: missing scheme, trailing slash, stray spaces.
function normalizeWorkerUrl(v) {
  v = String(v || '').replace(/\s+/g, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v.replace(/\/+$/, '');
}

export const cloudflareSink = {
  id: 'cloudflare',
  name: 'Cloudflare (raw markdown)',
  configFields: [
    {
      key: 'workerUrl',
      label: 'Worker URL',
      type: 'text',
      placeholder: 'https://ai-chat-md.<you>.workers.dev',
      required: true,
      normalize: normalizeWorkerUrl,
      help: '部署 worker/ 后得到的地址',
    },
    {
      key: 'writeToken',
      label: 'Write Token',
      type: 'password',
      placeholder: '与 worker 的 WRITE_TOKEN 一致',
      required: true,
      normalize: (v) => String(v || '').replace(/\s+/g, ''),
      help: '写入鉴权，需与 Worker secret 相同',
    },
  ],
  sync,
  testConnection,
};
