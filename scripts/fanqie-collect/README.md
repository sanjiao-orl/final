# fanqie-collect：番茄小说采集与解码（试车台批语料管道）

两阶段：fetch.mjs 抓原文（可断点续抓）→ decode.py 解码清洗成工作区 md。

## 原理（2026-08-28 实测）

- 书页 `https://fanqienovel.com/page/<bookId>` 内嵌 `__INITIAL_STATE__`（元数据）；目录 API
  `https://fanqienovel.com/api/reader/directory/detail?bookId=<bookId>` 给全书 itemId 与分卷；
  正文页 `https://fanqienovel.com/reader/<itemId>` 的 `reader.chapterData.content` 为 HTML 正文。
- **字体混淆**：正文里约半数常用字被替换为 PUA 码点（U+E3E8–U+E55B，共 362 个），
  靠内嵌 `@font-face` 子集字体渲染成真字。实测该字体**全站静态**
  （`awesome-font/c/dc027189e0ba4cd`，跨书/跨章/跨 UA 同一文件）：
  混淆集=300 个最常用汉字 + 数字 0-9 + 拉丁 a-z A-Z。
- 解码表 `font-map.json`：PUA→真字映射，由 `render_font_sheet.py` 渲染字形表后**人工识读**建立
  （字体 cmap 只指向源字体 gid，不可程序化反推；已用真实章节通读性验证）。
  若番茄换字体：重新渲染字形表、人工重建映射即可，管道不变。

## 环境

- fetch.mjs：Node.js ≥ 18（内置 fetch，零依赖）
- decode.py / render_font_sheet.py：`uv run`（fontTools/pillow 按需临时装）

## 用法

```bash
# 1) 采集（默认前 500 章到 .bench/raw/<书名>/，断点续抓；单章失败跳过、连续 5 章失败停）
node scripts/fanqie-collect/fetch.mjs <bookId> [--chapters 500] [--out .bench]

# 2) 字体变了才需要：渲染字形表 → 人工识读 → 更新 font-map.json
uv run scripts/fanqie-collect/render_font_sheet.py <font.otf> <out_dir>

# 3) 解码成 md（.bench/manuscript/<书名>/<卷>/<章题>.md + _decode-report.json QA）
uv run scripts/fanqie-collect/decode.py .bench/raw/<书名> .bench/manuscript/<书名>
```

## 版权纪律（与 qidian-ssr 一致）

语料仅本地自用测试：不出本机、不进 git（.bench/ 已 gitignore）、不分发、不用于任何产品功能。
限速 2.5–4.5s 随机；遇反爬/改版记阻塞点即停，不对抗。
