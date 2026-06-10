// Settings page — registry-driven. Renders one card per sink (enable toggle +
// config fields), loads current values from chrome.storage, saves back.
import { SINKS } from '../sinks/registry.js';
import { getSinkSettings, setSinkSettings } from '../background/sink-settings.js';

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
    root.append(card);
  }
}

function collect() {
  const sinks = {};
  for (const card of root.querySelectorAll('.sink')) {
    const sink = SINKS.find((s) => s.id === card.dataset.sinkId);
    const enabled = card.querySelector('.switch input').checked;
    const config = {};
    for (const f of sink.configFields) {
      config[f.key] = document.getElementById(fieldId(sink.id, f.key)).value.trim();
    }
    sinks[sink.id] = { enabled, config };
  }
  return sinks;
}

document.getElementById('save').addEventListener('click', async () => {
  await setSinkSettings(collect());
  statusEl.textContent = '已保存 ✓';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

(async () => render(await getSinkSettings()))();
