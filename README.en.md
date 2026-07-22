# Save AI Chat History

[中文](README.md)

A browser extension that archives your Claude / ChatGPT conversations — verbatim and incrementally — to Notion or your own Cloudflare Worker + R2.

**[→ Install from the Chrome Web Store](https://chromewebstore.google.com/detail/save-ai-chat-history/fghkefehlkfibbeeogmjeapalhdkmjdf)**

## Features

- **Verbatim**: both sides of the conversation, markdown / code blocks, thinking, tool calls, and uploaded files — including files Claude doesn't text-extract (`.jsonl` etc.; size cap adjustable in settings).
- **Never miss a turn**: message-id based diff sync — live chat, history backfill, and cross-device continuation all go through the same path.
- **Pluggable sinks**:
  - **Notion** — one page per conversation, files as child pages;
  - **Cloudflare Worker + R2** — raw markdown with a stable per-conversation URL you can hand straight to an AI. One-click deploy supported; manual guide (Chinese): [worker/README.md](worker/README.md).

    [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CY-Christin/save-ai-chat-history/tree/main/worker)
- **One-click export**: export the current conversation as `.md` from the popup; when large files are captured it becomes a `.zip` (one md + files under `files/`, referenced by relative links).

## Usage

1. Install from the store (or for local development: `npm install && npm run build`, then load `dist/` at `chrome://extensions`).
2. Open the extension settings page and enable at least one sink.
3. Chat on claude.ai / chatgpt.com as usual — sync happens automatically. The popup offers force-resync, copying the Cloudflare direct link, and export.

## How it works (short version)

No `fetch` patching — the extension treats a finished turn only as a *signal*, then re-fetches the platform's canonical conversation JSON and diffs it by message id against what each sink already has. Details live in the header comments of [src/inject/main-world.js](src/inject/main-world.js) and [src/background/service-worker.js](src/background/service-worker.js).

## Security

All credentials (Notion token, Worker write token) live only in `chrome.storage` — never in this repo or a build artifact. The packaging script ([package.mjs](package.mjs)) scans the bundle for credential-shaped strings before producing a zip.

## License

[MIT](LICENSE)
