# qidian-ssr：起点移动端 SSR 采集脚本（扫榜 + 取章）

WS-8《跑通记录-qidian-mcp.md》的落地脚本。结论：qidian-mcp-server 不整套接入（2026-08 实测三处失效），移动端 SSR 路径更轻更稳——普通 HTTP 请求、无浏览器、无登录墙，一个脚本覆盖「扫榜 + 取免费章节全文」。

## 原理

起点移动端（m.qidian.com）页面是 SSR 渲染，正文数据内嵌在 HTML 里：

```html
<script id="vite-plugin-ssr_pageContext" type="application/json">…</script>
```

- 榜单页 `https://m.qidian.com/rank/` → `pageContext.pageProps.pageData.<榜单key>`（每榜 Top 5）
- 书页 `https://m.qidian.com/book/<bid>/` → `bookInfo`（书名/作者/字数）+ `chapterContentInfo`（**首章全文** + 下一章 id）+ `recentChapters`
- 章节页 `https://m.qidian.com/chapter/<bid>/<cid>/` → `chapterInfo`（正文 `<p>` 段、章节名、`vipStatus`、`next`）

章节链：首章 id 从书页拿，后续章节沿 `next` 逐章跟进，`vipStatus != 0` 即停。

## 环境

- Node.js ≥ 18（用内置 `fetch`，零依赖，无需 `npm install`）
- 出网可达 m.qidian.com

## 用法

```bash
# 1) 扫榜（默认新人签约新书榜 newpRank，Top 5，可存 JSON）
node scripts/qidian-ssr/collect.mjs rank --list newpRank --top 5 --json ./rank.json

# 2) 取书前 3 章（默认 3 章；落到 .demo-work/manuscript/<书名>/）
node scripts/qidian-ssr/collect.mjs book 1050124322 --chapters 3
```

可选参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `--list` | 榜单 key：`newpRank`(新人签约新书榜) / `hotRank`(热销榜) / `dsRank`(大神榜) / `signRank`(签约榜) / `newFans`(新粉榜) / `readIndex`(阅读指数榜) / `recRank`(推荐榜) / `updRank`(更新榜) / `newbRank`(新书榜) / `fyRank`(飞跃榜) | `newpRank` |
| `--top` | 榜单打印条数（SSR 页当前每榜暴露 Top 5） | 5 |
| `--json` | 榜单结果另存 JSON 文件 | 不存 |
| `--chapters` | 取章数量 | 3 |
| `--out` | 语料输出目录（默认 `.demo-work/manuscript/`，按书名建卷目录） | 见左 |

## 输出

取章产物按仓库 `.demo-work` 的 md 规范组织：卷 = 目录、章 = 一个 `.md`、frontmatter 含 `title/status`：

```
.demo-work/manuscript/<书名>/
├── _fetch-summary.json      # 抓取摘要：书名/章节数/每章 CJK 字数/vip 状态/来源 URL
├── 第1章 xxx.md
├── 第2章 xxx.md
└── 第3章 xxx.md
```

章节 md 的 frontmatter 示例：

```yaml
---
title: 第1章 xxx
status: 语料
source: 起点中文网《书名》作者 · https://m.qidian.com/chapter/<bid>/<cid>/
---
```

正文每段一行、段间空行，纯文本，无站点噪声（脚本内置行清洗）。

## 纪律

- **限速**：请求间隔 2.5–4.5s 随机（`collect.mjs` 内 `DEFAULT_DELAY_MS`/`JITTER_MS`），单次少量请求，脚本可重复运行（重复抓取覆盖同名文件，幂等）。
- **付费边界**：只取免费公开章节（`vipStatus=0`）；遇 VIP 章节即停止并打印阻塞点，不重试。
- **阻塞点记录**：反爬/登录墙/页面改版（找不到 SSR JSON 或字段缺失）→ 打印明确错误即退出，不反复重试；页面结构变化时优先参考 WS-8 跑通记录里的 URL 形态核对。
- **版权纪律（重要）**：抓取语料**仅限本地自用测试**（供账本验证/T4 等开发测试），不得分发、转载、商用。仓库为私有时可随库提交；**若仓库转为公开，须先把抓取正文排除出 git**，只保留脚本与说明：

  ```gitignore
  # .gitignore 追加（仓库公开时必须启用）
  .demo-work/manuscript/<书名>/
  ```

  脚本与使用说明本身不涉及版权问题，可正常提交。

## 阻塞点记录（2026-08-12 首次落地）

无。榜单页、书页、章节页三处 SSR 全部直通（与 WS-8 结论一致）。若后续失效，在本节追加记录。
