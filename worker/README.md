# Raw Markdown Worker

一个很小的 Cloudflare Worker：每个对话在 R2 里存一个 markdown 对象（上传的文件单独存），提供稳定 URL，可以直接丢给 AI 读。R2 的强读写一致性保证了追加写（读-改-写）的正确性。

API（`GET` / `PUT` / `POST /conv/{id}`）见 [`src/index.js`](src/index.js)。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CY-Christin/save-ai-chat-history/tree/main/worker)

点按钮后 Cloudflare 会把 `worker/` 复制成你账号下的一个新仓库，自动创建 R2 bucket 并构建部署（没有 Cloudflare 账号的话流程里会引导注册，免费版即可）。

部署完成后**还差一步——设置写入令牌**：

1. 打开 [dashboard](https://dash.cloudflare.com) → Workers & Pages → 你的 Worker → **Settings → Variables and Secrets**；
2. **Add** 一个 **Secret**，名称 `WRITE_TOKEN`，值为任意足够长的随机字符串（比如本地跑 `openssl rand -hex 32` 生成）。

记下 Worker 的地址（形如 `https://ai-chat-md.<你的子域>.workers.dev`），到扩展里配置（见下）。

## 手动部署教程

前置：Node.js ≥ 18、一个 Cloudflare 账号（免费版额度对个人使用绰绰有余）。

```sh
git clone https://github.com/CY-Christin/save-ai-chat-history.git
cd save-ai-chat-history/worker

# 1. 登录（跳转浏览器授权）
npx wrangler login

# 2. 创建 R2 bucket（名字须与 wrangler.toml 的 bucket_name 一致；
#    首次使用 R2 需要先在 dashboard 的 R2 页面点一下开通）
npx wrangler r2 bucket create ai-chat-md

# 3. 设置写入令牌（提示输入时粘贴一个随机字符串，如 openssl rand -hex 32 的输出）
npx wrangler secret put WRITE_TOKEN

# 4. 部署，记下打印出的 URL
npx wrangler deploy
```

本地开发（可选）：`cp .dev.vars.example .dev.vars` 填入 token，然后 `npx wrangler dev`。

## 在扩展里使用

扩展设置页启用 **Cloudflare (raw markdown)**，填入：

- **Worker URL**：上面部署得到的地址；
- **Write Token**：与 `WRITE_TOKEN` 相同的值（「测试连接」按钮可以验证）。

之后每个对话都能在 `<Worker URL>/conv/<conversation-id>` 读到——在对话页打开扩展 popup 会直接显示并可复制这个直链。

## 安全

读是公开的（unlisted——拿到 URL / 对话 id 就能读）；写需要 bearer token。你把某个 `/conv/{id}` 链接给谁（包括让某个 AI 去读），谁就能看到那个对话——不要把机密写进要同步的聊天里。
