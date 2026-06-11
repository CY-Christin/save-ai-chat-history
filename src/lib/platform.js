// Per-platform display metadata shared by sinks: Notion page/database names and
// markdown speaker labels all derive from this, so adding a platform here is the
// only "presentation" change a new adapter needs.
const PLATFORM_LABEL = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
};

export function platformLabel(platform) {
  return PLATFORM_LABEL[platform] || String(platform || 'AI');
}
