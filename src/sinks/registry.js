// Sink registry — the list of sync targets. Add one by implementing
// the sink contract and pushing it here; the settings page, popup and the
// background sync loop all pick it up automatically.
//
// Contract:
//   { id, name, configFields, sync(config, conv, alreadySynced), testConnection? }
//   - configFields[].normalize?  (v) => v   — applied on save (fix common paste mistakes)
//   - sync returns { newlySynced, ref, error? } — on a mid-conversation failure,
//     return the ids that DID land plus the error (don't throw), so the caller
//     marks partial progress and the rest resumes next trigger.
//   - testConnection(config) → { ok, message } — settings-page「测试连接」.
import { notionSink } from './notion.js';
import { cloudflareSink } from './cloudflare.js';

export const SINKS = [notionSink, cloudflareSink];

export function getSink(id) {
  return SINKS.find((s) => s.id === id) || null;
}
