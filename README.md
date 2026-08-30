# novel-ws（小说写作工作台）

网文连载单作者的本地 AI 写作工作台（Windows 桌面、纯本地、无账号、BYOK）。当前事实与规划的唯一基准是 `docs/current/现状.md`；协作纪律见 `AGENTS.md`。

## 快速开始

```bash
npm install

npm run dev:core        # 起 sidecar 核心（自动分配端口，打印 port/token，写 core-runtime.local.json，含版本/commit/协议自报）
# 浏览器打开 http://127.0.0.1:<port>/v1/dev → 裸联调页（对话/流式/工具/多会话，仅 dev 运行时开放；协议契约见 docs/reference/03-协议契约.md）

npm run dev:shell       # 起 Tauri 桌面壳（以固定端口 47832 拉起 core）

node core/scripts/e2e.mjs            # 真实 LLM e2e（key 在场才跑）
node core/scripts/e2e-workflow.mjs   # 写作闭环剧本：碰撞→留痕闸门→起草→暂存→采纳→落章→快照→冷读（12 步，真实 LLM）
```

LLM_* 环境变量检查：`scripts/check-env.ps1`（PowerShell）。

## 包结构

- `core/` — sidecar 核心：HTTP+SSE server、AI SDK v7、MCP client、node:sqlite 会话持久化
- `domain/` — MCP 领域服务（38 工具）：结构树（卷/章/场）、章节读写（原子写）、搜索、字数统计、生产与组织、历史快照、声口指纹等
- `shell/` — Tauri 2 + Svelte 5 + TipTap 桌面壳：v5 五栏布局、结构树 + 作者笔记（AI 物理不可见）、多候选浮层、ask/auto/yolo 审批、快照浏览器、设置面板、碰撞模式与触发式续写（功能全景见 `docs/current/现状.md`，此处不展开）
- `docs/` — 五层：`current/` 现状与待办（日常唯一加载）；`reference/` 现行规范四件（产品定义/字数口径/协议契约/prompt 机制）；`work/` 调研排查件；`drafts/` 未定稿草案；`archive/` 历史（默认不加载）
- `scripts/` — 工程脚本（release / check-versions / check-docs / perf-benchmark / build-sidecar）与语料工具（`yuedu/`、`qidian-ssr/`、`fanqie-collect/`）
- `.demo-work/` — 演示作品（测试文本，随时可删）

## 语料采集（`scripts/yuedu/`，非产品代码，不进 CI）

《阅读》(Legado) 书源机制的本地蒸馏：书源规则 DSL 引擎（默认/jsoup、@css:、@json:、正则净化、URL 模板）+ 三层净化 + 限速抓取 + 保真度门，可直接导入其生态的书源 JSON（`sources/` 内置 150 个精选源）。语料带溯源 frontmatter 落 `.bench/yuedu/`（gitignored，不分发）。

- **图形界面（推荐）**：双击 `scripts/yuedu/启动蒸馏台.bat` —— 自动装依赖（仅首次）→ 起本地服务（只绑 127.0.0.1）→ 自动开浏览器。四页签：抓书 / 书源（150 源静态画像过滤） / 净化 / 说明。书源可留空由工具自动挑可用源。
- **命令行**：`node scripts/yuedu/cli.mjs search|info|toc|fetch|clean|sources …`（全参数见 `scripts/yuedu/README.md`）。
- 测试：`cd scripts/yuedu && npm test`（23 用例，含本地 mock 书站端到端）；GUI 链路：先起服务再 `node test/gui-smoke.mjs`。

## 验收口径

- `npm run check`（含 check-versions 六处版本一致 + check:docs 文档防腐）/ `npm test`（1011 用例：core 249 + domain 364 + shell 398；另 cargo test 19）
- 写作闭环 `node core/scripts/e2e-workflow.mjs`（12 步）与行为回归 `npm run promptfoo`（四用例）均真实 LLM、key 在场手动跑、不进 CI；GitHub Actions CI 门禁同口径（check+test+cargo test）
- 出口度量：真实长篇试车台（番茄/公版书灌真书）为日常尺子，作者真实写作为期末考；不以测试绿为验收

## production 打包（sidecar 随安装包分发）

`npm run build:sidecar` 用 esbuild 把 core/domain 打成单文件 ESM bundle 并把本机 Node 运行时复制进壳资源目录 → `cd shell && npx tauri build` 收进安装包。release 壳从 Tauri resource_dir 拉起 node.exe + bundle；dev 模式仍走仓库源码 + `tsx`，行为不变。作品目录：dev 为 `<repo>/.demo-work`，prod 为系统应用数据目录下 `.demo-work`。

## 更新通道

- Tauri updater 标准静态 `latest.json`：`https://github.com/sanjiao-orl/final/releases/latest/download/latest.json`。启动后台检查，发现新版本即下载校验并 passive 安装。
- 发布（仓库根，需 `gh` 已登录）：

  ```bash
  npm run release -- 0.2.12             # 指定版本；或 patch / minor / major 自增
  npm run release -- patch --dry-run    # 无副作用演练：只读预检 + 版本内存校验 + 打印动作计划
  ```

  脚本流程：工作树预检（有未提交改动即拦截）→ 六处版本号事务化同步（写完由 check-versions 自检）→ 带签名私钥跑 `npx tauri build --ci`（仅 NSIS，MSI 已弃）→ 生成 `latest.json` → 版本落账（commit/tag/push，幂等）→ 建草稿 release 逐文件上传（失败重跑同一命令续传）→ 全部传完才发布。
- 签名私钥在仓外 `%USERPROFILE%\.tauri\novel-ws.key`（本仓为空密码，私钥绝不入库；可用 `TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 覆盖）。
- 护栏：自增算出的版本其本地 tag 已存在即拦截；CI 门禁见 `.github/workflows/ci.yml`。

## 发布记录

逐版记录归 git 管，此处不手写台账：当前最新 **v0.2.11**（块 2 声口批 + 修复批 R4 六件 + 随版归档纪律生效），历史见 git tag 与提交史。

## 已知现象

- **AI 对话"不流式"**：壳全链路是流式的（core 逐帧 SSE → 壳 40ms 批次渲染）。若观感是整段一次性蹦出，多半是 provider/代理端不流式或粗粒度吐——可用 `/v1/dev` 联调页直接观察 SSE 帧间隔验证（免鉴权）。属供应商行为，壳不兜底。
