// Popup — minimal defensive surface: shows at a glance whether any sink will
// actually sync ("why is nothing happening?"), and offers force-resync for the
// current conversation (clears synced state + retriggers; sinks then take their
// "first sync = clean rewrite" path, so nothing duplicates).
import { zipSync, strToU8 } from 'fflate';
import { SINKS } from '../sinks/registry.js';
import { getSinkSettings, isConfigComplete } from '../background/sink-settings.js';

const PLATFORM_URLS = [
  { platform: 'claude', re: /^https:\/\/claude\.ai\/chat\/([0-9a-fA-F-]{36})/ },
  { platform: 'chatgpt', re: /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:g\/[^/]+\/)?c\/([0-9a-fA-F-]{36})/ },
];

function matchConversation(url) {
  for (const { platform, re } of PLATFORM_URLS) {
    const m = (url || '').match(re);
    if (m) return { platform, convId: m[1] };
  }
  return null;
}

const sinksEl = document.getElementById('sinks');
const convEl = document.getElementById('conv');
const btn = document.getElementById('resync');
const exportBtn = document.getElementById('export');
const resultEl = document.getElementById('result');

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(async () => {
  // Sink health, one line. (Doesn't know about the gitignored dev fallback —
  // that's dev-only by design.)
  const settings = await getSinkSettings();
  const parts = SINKS.filter((s) => settings[s.id]?.enabled).map((s) =>
    isConfigComplete(s, settings[s.id].config) ? `${s.name} ✓` : `${s.name} ⚠ 配置不完整`
  );
  sinksEl.textContent = parts.length ? '同步目标：' + parts.join(' · ') : '⚠ 未启用任何同步目标';
  if (!parts.length || parts.some((p) => p.includes('⚠'))) sinksEl.classList.add('warn');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const hit = matchConversation(tab?.url);
  if (!hit) {
    convEl.textContent = '当前标签页不是支持的对话页（打开 claude.ai / chatgpt.com 的对话后再试）';
    return;
  }
  convEl.textContent = `当前对话：${hit.platform} · ${hit.convId.slice(0, 8)}…`;
  btn.hidden = false;
  exportBtn.hidden = false;

  // Public link to this conversation's raw markdown — the worker's GET route
  // is unauthenticated, so the configured Worker URL is all we need. Shown
  // only when the Cloudflare sink is enabled.
  const cf = settings.cloudflare;
  const workerBase = (cf?.enabled && cf.config?.workerUrl) || '';
  if (workerBase) {
    const url = `${workerBase.replace(/\/+$/, '')}/conv/${hit.convId}`;
    const a = document.getElementById('convUrl');
    a.href = url;
    a.title = url;
    a.textContent = url.replace(/^https?:\/\//, '');
    document.getElementById('convCopy').addEventListener('click', async (e) => {
      e.preventDefault();
      await navigator.clipboard.writeText(url);
      e.target.textContent = '已复制 ✓';
      setTimeout(() => (e.target.textContent = '复制'), 1500);
    });
    document.getElementById('convLink').hidden = false;
  }

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    resultEl.style.color = '#888';
    resultEl.textContent = '抓取对话中…';
    try {
      // md 还是 zip 由后台按设置页的「抓取/外置文件」配置决定。
      const r = await chrome.runtime.sendMessage({
        kind: 'control',
        type: 'export',
        platform: hit.platform,
        convId: hit.convId,
        tabId: tab.id,
      });
      if (!r?.ok) throw new Error(r?.message || '后台无响应');
      const name = (r.title || '').replace(/[\\/:*?"<>|]/g, ' ').trim() || `${hit.platform}-${hit.convId.slice(0, 8)}`;
      let blob, filename;
      if (r.kind === 'zip') {
        const entries = { [`${name}.md`]: strToU8(r.md) };
        for (const f of r.files || []) entries[`files/${f.name}`] = strToU8(f.content);
        blob = new Blob([zipSync(entries)], { type: 'application/zip' });
        filename = `${name}.zip`;
      } else {
        blob = new Blob([r.md], { type: 'text/markdown' });
        filename = `${name}.md`;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      resultEl.style.color = '#10b981';
      resultEl.textContent = `✓ 已导出 ${filename}`;
    } catch (e) {
      resultEl.style.color = '#ef4444';
      resultEl.textContent = '✗ ' + e.message;
    } finally {
      exportBtn.disabled = false;
    }
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    resultEl.style.color = '#888';
    resultEl.textContent = '处理中…';
    try {
      const r = await chrome.runtime.sendMessage({
        kind: 'control',
        type: 'forceResync',
        platform: hit.platform,
        convId: hit.convId,
        tabId: tab.id,
      });
      resultEl.style.color = r?.ok ? '#10b981' : '#ef4444';
      resultEl.textContent = (r?.ok ? '✓ ' : '✗ ') + (r?.message || '后台无响应');
    } catch (e) {
      resultEl.style.color = '#ef4444';
      resultEl.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });
})();
