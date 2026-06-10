// Read/write per-sink settings in chrome.storage. Shared by the settings page
// and the background sync loop. Pure storage — no credentials hardcoded here.
//
// Shape:
//   chrome.storage.local.sinks = {
//     notion:     { enabled: true,  config: { token, rootPageId } },
//     cloudflare: { enabled: false, config: { ... } },
//   }

const KEY = 'sinks';

export async function getSinkSettings() {
  const { [KEY]: sinks } = await chrome.storage.local.get(KEY);
  return sinks || {};
}

export async function setSinkSettings(sinks) {
  await chrome.storage.local.set({ [KEY]: sinks });
}

// True when every required field of a sink has a non-empty value.
export function isConfigComplete(sink, config) {
  return sink.configFields.every((f) => !f.required || (config && config[f.key]));
}
