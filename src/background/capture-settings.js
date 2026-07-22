// Capture-level settings (not tied to any sink), stored beside `sinks`.
// Shared by the settings page and the content-script bridge (which relays the
// values into the MAIN-world capture script — page context can't read storage).
//
// Shape:
//   chrome.storage.local.capture = { blobMaxMB: number, externalizeFiles: boolean }
//
// blobMaxMB — size cap for downloading Claude "blob" uploads (.jsonl and other
// files Claude doesn't text-extract) and inlining their content into syncs and
// exports. Slider stops in the settings page (0/0.25/0.5/1/2/5/10/20/50/100);
// 0 = don't capture. Files over the cap stay name-only refs with a note.
//
// externalizeFiles — when the cap is ≥2MB (big files can be captured), export
// as .zip with files under files/ instead of inlining them into the .md.
// Irrelevant (and hidden in the UI) below 2MB, where export stays a single .md.

const KEY = 'capture';
export const DEFAULT_BLOB_MAX_MB = 1;
export const EXTERNALIZE_MIN_MB = 2;

export async function getCaptureSettings() {
  const { [KEY]: capture } = await chrome.storage.local.get(KEY);
  return { blobMaxMB: DEFAULT_BLOB_MAX_MB, externalizeFiles: true, ...(capture || {}) };
}

export async function setCaptureSettings(capture) {
  await chrome.storage.local.set({ [KEY]: capture });
}
