# Privacy Policy — Save AI Chat History

_Last updated: 2026-07-14_

Save AI Chat History is a browser extension that archives your AI chat
conversations (Claude, ChatGPT) to storage destinations **you** configure — your
own Notion workspace and/or your own Cloudflare Worker. It has no server of its
own and sends nothing to the developer.

## What the extension accesses

- **Conversation content** on `claude.ai`, `chatgpt.com`, and
  `chat.openai.com`: when you view or continue a conversation there, the
  extension re-fetches that conversation from the platform's own API (using
  your existing login session) so it can sync the messages verbatim.
- **A session credential, transiently, on ChatGPT only**: to call ChatGPT's
  conversation API the extension reads the page's own session access token the
  same way the page does. The token is used in-page for that single request and
  is never stored, logged, or transmitted anywhere else.

The extension does not read your browsing history, does not run on any site
other than the ones listed above, and does not collect analytics or telemetry
of any kind.

## Where your data goes

Conversation content is sent **only** to destinations you explicitly configure
in the extension's settings:

- **Notion** (`api.notion.com`): pages are created in your own Notion
  workspace, authenticated by an integration token you create and enter
  yourself.
- **Your own Cloudflare Worker** (optional): markdown copies are stored in an
  R2 bucket under your own Cloudflare account, authenticated by a write token
  you set yourself.

If you configure no destination, nothing leaves your browser. The developer
operates no server and never receives your conversations, tokens, or any other
data.

## What is stored locally

Extension settings — your Notion integration token, root page ID, optional
Worker URL and write token, and per-conversation sync state (message IDs
already synced) — are stored in Chrome's extension storage
(`chrome.storage.local`) on your device. Uninstalling the extension deletes all
of it.

## Data sharing and sale

None. No data is sold, shared with third parties, or used for advertising or
credit purposes. Data is used solely to provide the extension's single feature:
archiving your conversations to your configured destinations.

## Your data, your accounts

Everything the extension writes lives in accounts you own (Notion, Cloudflare).
Deleting synced content there, or uninstalling the extension, is entirely under
your control.

## Contact

Questions or concerns: open an issue on this repository, or email
`chr1st1n.ch3ng@gmail.com`.
