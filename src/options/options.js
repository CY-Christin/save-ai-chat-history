// Settings page — registry-driven. Renders one card per sink (enable toggle +
// config fields + test-connection), loads current values from chrome.storage,
// saves back. Field values are normalized on save (fix common paste mistakes).
import { SINKS } from '../sinks/registry.js';
import { getSinkSettings, setSinkSettings, isConfigComplete } from '../background/sink-settings.js';

const root = document.getElementById('sinks');
const statusEl = document.getElementById('status');

function fieldId(sinkId, key) {
  return `f_${sinkId}_${key}`;
}

function render(settings) {
  root.innerHTML = '';
  for (const sink of SINKS) {
    const setting = settings[sink.id] || {};
    const config = setting.config || {};

    const card = document.createElement('div');
    card.className = 'sink' + (setting.enabled ? '' : ' disabled');
    card.dataset.sinkId = sink.id;

    const head = document.createElement('div');
    head.className = 'sink-head';
    head.innerHTML = `<h2>${sink.name}</h2>`;

    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!setting.enabled;
    cb.addEventListener('change', () => card.classList.toggle('disabled', !cb.checked));
    sw.append(cb, document.createTextNode('启用'));
    head.append(sw);
    card.append(head);

    const fields = document.createElement('div');
    fields.className = 'fields';
    for (const f of sink.configFields) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const input = `<input id="${fieldId(sink.id, f.key)}" type="${f.type || 'text'}"
        placeholder="${f.placeholder || ''}" value="${(config[f.key] || '').replace(/"/g, '&quot;')}" />`;
      wrap.innerHTML =
        `<label>${f.label}${f.required ? ' *' : ''}</label>${input}` +
        (f.help ? `<div class="help">${f.help}</div>` : '');
      fields.append(wrap);
    }
    card.append(fields);

    // 测试连接 — runs against the CURRENT form values (not what's saved), so
    // the natural flow is: fill → test → save.
    if (typeof sink.testConnection === 'function') {
      const foot = document.createElement('div');
      foot.className = 'sink-foot';
      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'secondary';
      testBtn.textContent = '测试连接';
      const result = document.createElement('span');
      result.className = 'test-result';
      testBtn.addEventListener('click', async () => {
        const cfg = collectSinkConfig(sink);
        if (!isConfigComplete(sink, cfg)) {
          showResult(result, false, '请先填写必填项');
          return;
        }
        testBtn.disabled = true;
        result.style.color = '#888';
        result.textContent = '测试中…';
        try {
          const r = await sink.testConnection(cfg);
          showResult(result, r.ok, r.message);
        } catch (e) {
          showResult(result, false, e.message);
        } finally {
          testBtn.disabled = false;
        }
      });
      foot.append(testBtn, result);
      card.append(foot);
    }
    root.append(card);
  }
}

function showResult(el, ok, message) {
  el.textContent = (ok ? '✓ ' : '✗ ') + message;
  el.style.color = ok ? '#10b981' : '#ef4444';
}

// Read one sink's config from the form, applying each field's normalizer
// (URL → page id, strip whitespace, add https://, …).
function collectSinkConfig(sink) {
  const config = {};
  for (const f of sink.configFields) {
    let v = document.getElementById(fieldId(sink.id, f.key)).value.trim();
    if (f.normalize) v = f.normalize(v);
    config[f.key] = v;
  }
  return config;
}

function collect() {
  const sinks = {};
  for (const card of root.querySelectorAll('.sink')) {
    const sink = SINKS.find((s) => s.id === card.dataset.sinkId);
    const enabled = card.querySelector('.switch input').checked;
    sinks[sink.id] = { enabled, config: collectSinkConfig(sink) };
  }
  return sinks;
}

document.getElementById('save').addEventListener('click', async () => {
  const sinks = collect();
  await setSinkSettings(sinks);
  // Re-render so normalized values (e.g. URL → extracted page id) are visible.
  render(sinks);

  const incomplete = SINKS.filter(
    (s) => sinks[s.id]?.enabled && !isConfigComplete(s, sinks[s.id].config)
  ).map((s) => s.name);
  if (incomplete.length) {
    statusEl.style.color = '#f59e0b';
    statusEl.textContent = `已保存，但 ${incomplete.join('、')} 缺少必填项 — 同步时会被跳过 ⚠`;
  } else {
    statusEl.style.color = '#10b981';
    statusEl.textContent = '已保存 ✓';
    setTimeout(() => (statusEl.textContent = ''), 2000);
  }
});

(async () => render(await getSinkSettings()))();
