# Save AI Chat History

[English](README.en.md)

自动把 Claude / ChatGPT 的对话完整存档到 Notion 或你自己的 Cloudflare Worker + R2 的浏览器扩展。

**[→ Chrome Web Store 安装](https://chromewebstore.google.com/detail/save-ai-chat-history/fghkefehlkfibbeeogmjeapalhdkmjdf)**

## 功能

- **原样保存**：双方消息、markdown / 代码块、思考过程、工具调用、上传的文件——包括 Claude 未做文本提取的 `.jsonl` 等文件（抓取上限可在设置中调整）。
- **不漏一轮**：基于消息 id 的增量 diff 同步，实时对话、历史回填、跨设备续聊走同一条路径。
- **可插拔同步目标**：
  - **Notion** — 每个对话一页，文件作为子页面；
  - **Cloudflare Worker + R2** — 原始 markdown，每个对话有稳定直链，可以直接丢给 AI 读。支持[一键部署](https://deploy.workers.cloudflare.com/?url=https://github.com/CY-Christin/save-ai-chat-history/tree/main/worker)，手动部署教程见 [worker/README.md](worker/README.md)。
- **一键导出**：popup 里把当前对话导出为 `.md`；允许抓取大文件时自动打包 `.zip`（正文一个 md，文件外置在 `files/` 目录、相对链接引用）。

## 使用

1. 从商店安装（或本地开发：`npm install && npm run build` 后在 `chrome://extensions` 加载 `dist/`）。
2. 打开扩展设置页，启用并配置至少一个同步目标。
3. 正常在 claude.ai / chatgpt.com 聊天即可，同步自动发生；popup 里可强制重同步、复制 Cloudflare 直链、导出当前对话。

## 工作原理（一句话版）

不 patch 任何页面的 `fetch`——只把「一轮回答完成」当作触发信号，重新拉取平台的规范对话 JSON，按消息 id 与各同步目标已有内容做 diff 后增量写入。细节见 [src/inject/main-world.js](src/inject/main-world.js) 与 [src/background/service-worker.js](src/background/service-worker.js) 的头部注释。

## 安全

所有凭据（Notion token、Worker write token）只存在浏览器的 `chrome.storage` 里，不会出现在仓库或构建产物中；打包脚本（[package.mjs](package.mjs)）在出包前会做凭证形状扫描兜底。

## License

[MIT](LICENSE)
