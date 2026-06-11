// Popup — minimal defensive surface: shows at a glance whether any sink will
// actually sync ("why is nothing happening?"), and offers force-resync for the
// current conversation (clears synced state + retriggers; sinks then take their
// "first sync = clean rewrite" path, so nothing duplicates).
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
