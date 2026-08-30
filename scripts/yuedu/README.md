# yuedu-distill —— 《阅读》(Legado) 书源机制的本地蒸馏

面向本仓库语料采集（`.bench/`）的独立小工具：实现 Legado 3.0 书源规则 DSL 的常用子集，
可直接**导入其生态的书源 JSON**（精选集合已放 `sources/`），完成 搜索 → 详情 → 目录 →
逐章正文 → 三层净化 → 保真度统计 → 落盘 全链路。非产品代码，不进 CI。

## 蒸馏了什么

| Legado 机制 | 本工具对应 | 位置 |
|---|---|---|
| AnalyzeRule（默认/jsoup 规则） | `class.x.0@tag.a@text`、`children`、`[0]`/`[-1]`/`[0:3]`/`[!0]`/`[a,b]`、列表倒序 `-`、`li!0` 裸标签排除 | `src/analyze-rule.mjs` |
| @css: / @json: / `$.` 规则 | cheerio / jsonpath-plus；JSON 响应自动切 json 上下文；裸属性路径（`name`） | 同上 |
| `##正则##替换` / `###` OnlyOne / `:` AllInOne 列表 | 同语义实现（`$1` 组引用；AllInOne 组上下文） | `src/rule-tokenizer.mjs` + 引擎 |
| `||` 回退 / `&&` 合并 / `%%` 交集 | 前两者支持；`%%` 显式不支持 | `src/rule-tokenizer.mjs` |
| AnalyzeUrl | `{{key}}`（按 charset 百分号编码）/`{{page}}`/`<,{{page}}>`、`url,{method/body/charset/headers/retry}`、POST body 按 charset 转字节、相对 URL 解析、`{$.x}` 内联、模板型字段（`/novel/{{$.novelId}}`） | `src/analyze-url.mjs` |
| ruleBookInfo.init 预处理 | 详情字段上下文切到 init 结果（如 `$.data`） | `src/pipeline.mjs` |
| 多页目录 / 正文翻页 | `nextTocUrl`（≤50 页）/`nextContentUrl`（≤30 页）循环 | `src/pipeline.mjs` |
| 替换净化 | **三层**：书源 `replaceRegex`（`{"old","new"}`/数组）→ 用户规则 `clean-rules.user.json` → 内置广告模式；逐层计数透出 | `src/clean.mjs` |
| CookieJar | 按 host 存取 Set-Cookie（`.bench/yuedu/.cookies.json`）；登录态用 `--cookie` 注入 | `src/fetcher.mjs` |
| 并发率/重试 | 随机限速（缺省 2.5–4.5s）、超时 20s、重试 2 次退避 | 同上 |
| —（本项目纪律） | **阻塞即停**（连续 3 次失败/反爬特征即中止）、**保真度门**（逐章字数统计，< 中位 50% 或 `--min-chars` 标 suspect）、**溯源 frontmatter**（书源/章 URL/抓取时间）、断点续采（`.state.json`） | `src/fetcher.mjs` + `src/pipeline.mjs` |

**明确不支持（报错不静默错取）**：`@js:`/`<js>`、`@XPath:`/`//`、`@get/@put`、`%%`、
`webView`/`webJs`/`sourceRegex`、`loginUrl` 自动登录。`sources validate` 会按源给出画像。

## 图形界面（双击启动）

双击 **`scripts/yuedu/启动蒸馏台.bat`**：自动装依赖（首次）→ 起本地服务 → 自动开浏览器。
也可以命令行启动：`node scripts/yuedu/gui-server.mjs [--port 8765] [--no-open]`（只绑 127.0.0.1）。

界面四页，全部操作可选项化：

- **抓书**：书源（留空=自动依次试 full 源直到命中）→ 搜书 → 选书 → 可选项（输出目录 /
  最多章数 / 疑点阈值 / 限速区间 / Cookie 登录态 / 续抓 / 内置净化开关）→ 开始/停止；
  实时进度条 + 日志 + 完成统计（成功/失败/疑点/净化命中）+ 报告摘要。
- **书源**：150 源列表，静态画像过滤（full/partial/unusable + 缺什么能力），一键跳搜索。
- **净化**：单文件三层净化（书源 replaceRegex → 用户规则 → 内置广告库），配**净化规则表**（Legado 替换净化同款）：逐条勾选启用/停用（含按名停用内置）、增删改用户规则，存 `clean-rules.user.json`（对象形态 `{rules, disabledBuiltin}`，旧数组形态兼容，`enabled:false` 即停用）。
- **说明**：流程与纪律速览。

任务进度走 `/api/job/:id` 轮询；停止在章节间生效，已抓章落盘，勾「续抓」可断点继续。
测试：`node test/gui-smoke.mjs`（需先起服务）——mock 书站走 GUI API 验证全链路 10 项断言。

## 用法（在 C:\final 根目录）

```bash
node scripts/yuedu/cli.mjs sources list [关键词]          # 列书源
node scripts/yuedu/cli.mjs sources validate [文件|all]    # 可用性画像（full/partial/unusable）
node scripts/yuedu/cli.mjs search   <源> <关键词> [--limit 10]
node scripts/yuedu/cli.mjs info     <源> <bookUrl>
node scripts/yuedu/cli.mjs toc      <源> <bookUrl> [--limit 30]
node scripts/yuedu/cli.mjs fetch    <源> <bookUrl> [--out .bench/yuedu/书名] [--max 3]
                                    [--resume] [--min-chars N] [--delay 2500,4500]
                                    [--cookie "k=v"] [--no-builtin-clean]
node scripts/yuedu/cli.mjs clean    <文件> [--out 文件] [--rules 用户规则.json]
```

`<源>` = 书源名的包含匹配 / bookSourceUrl 片段 / 列表下标。

## 导出布局

```
.bench/yuedu/<书名>/
  manuscript/0001-章名.md   # frontmatter: title/index/status:语料/source/chapterUrl/fetchedAt/rawChars/chars
  book.json                 # 书籍信息 + 逐章状态（suspect/error 标记）
  report.md                 # 抓取报告：目录/成功/失败/阻塞/保真度/净化计数/警告
  .state.json               # 断点续采
```

## 书源集合（已导入）

- `sources/XIU2-yuedu.json` —— [XIU2/yuedu](https://github.com/XIU2/yuedu) 自用精选 22 源
- `sources/aoaostar-4dc410d1.json` —— [aoaostar/legado](https://github.com/aoaostar/legado) 合集 128 源

规则语法规格出处：`docs/ruleHelp.md`（LegadoTeam 官方帮助）与
`docs/source-tutorial.txt`（Celeter/喵公子《书源规则：从入门到入土》）。

## 已知边界

- 云机房 IP 会被大量小说站 403（`阻塞即停` 按设计触发）——本机家用网络跑成功率高得多。
- 书源生态腐烂快：validate 的 `partial/unusable` 画像 + 报告的 warnings 是排查起点。
- **App-API 源的内嵌 token 会过期**（典型：猫眼看书，2022 年的 JWT，服务端 `业务码 4005：认证失败`）。
  这类源 search 往往公开可用、详情/目录/正文全在登录态后面——在《阅读》本尊里同样失效，
  只能当搜索/发现用，不能产出语料；章节 URL 还常叠 AES 解密（`java.aesBase64DecodeToString`，引擎 v1 不执行 JS）。
  空结果时 CLI 会把业务码/响应开头带进报错，一眼区分「被拒」与「无结果」。
- 单引号伪 JSON header（如 `{'User-Agent': 'okhttp/4.9.2'}`）按 Legado Gson 宽松语义解析（影响 8/150 源）。
- JS/XPath 源（现代合集里占比不小）需要引擎 v2 再吃下；当前 150 源中 full≈62。
- 版权纪律：语料仅进 gitignored 的 `.bench/`、不分发、报告引用脱敏；只用自己账号的登录态。
