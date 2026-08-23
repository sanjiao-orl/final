# novel-ws(小说写作工作台)

网文连载单作者的本地 AI 写作工作台。架构与纪律见 `AGENTS.md`。

## 快速开始

```bash
npm install

# 配置模型(三要素缺一不可,已写入用户级环境变量,新开终端即生效)
#   LLM_BASE_URL  https://opencode.ai/zen/go/v1(OpenCode Go 订阅,复用 OPENCODE_API_KEY;key 存放处见 AGENTS.md)
#   LLM_API_KEY   OpenCode key
#   LLM_MODEL     deepseek-v4-pro(写作档)
#   LLM_MODEL_CHEAP  deepseek-v4-flash(后台档,缺省回退 LLM_MODEL)
# 注:裸 /zen/v1 端点付费模型余额不足会 402;/zen/go/v1 为 Go 订阅模型池,可用模型以 GET /models 为准
# 多模型池(可选,D4):LLM_PRESET_<名>_BASE_URL / LLM_PRESET_<名>_API_KEY / LLM_PRESET_<名>_MODEL 定义预设,可多家 provider;
#   LLM_ASSIGN_WRITING / LLM_ASSIGN_BACKGROUND / LLM_ASSIGN_REVIEW 把三用途绑到预设 id;
#   有任一预设即走预设表(未分配用途回退第一预设),无预设回退上面双档;壳设置面板同构(config.json 优先于环境变量)

npm run dev:core        # 起 sidecar 核心(打印 port/token,写 core-runtime.local.json,含版本/commit/协议自报)
# 浏览器打开 http://127.0.0.1:<port>/v1/dev → 裸联调页(对话/流式/工具/多会话,仅 dev 运行时开放,prod 安装包关闭);协议契约见 docs/decisions/0007

node core/scripts/e2e.mjs            # 真实 LLM e2e(key 在场才跑)
node core/scripts/e2e-workflow.mjs   # 写作闭环剧本:碰撞→留痕闸门→起草→暂存→采纳→落章→快照→冷读(10 步,含触发式续写,真实 LLM)
```

## 包结构

- `core/` — sidecar 核心:HTTP+SSE server、AI SDK v7、MCP client、node:sqlite 会话持久化
- `domain/` — MCP 领域服务:结构树(卷/章/场,标题派生)、章节读写(原子写)、搜索、字数统计、章/卷生产与组织(新建/重命名/卷内重排)、历史快照读取
- `shell/` — Tauri 2 + Svelte 5 + TipTap 壳(v5 布局:48px AI 窄条 + 会话/对话/工具/上下文/设置五栏,点击切换;左侧结构树 + 作者笔记(AI 物理不可见);多候选浮层 B1、工具卡 B3/B10、快照浏览器、目标字数 B5、ask/auto/yolo 审批 B6、会话多级挂载 B7、采纳留痕 B8、树搜索/场大纲/拖拽 B9、设置面板;方案 pill 与碰撞模式(四节对比色+blueprint 徽标)、触发式续写、AI 面板钉住与选区转对话;暂存区左栏 tab+正文区查看候选、选区引用附件化、模型生效态单源;码字日历热力图、章发布状态流转、平台格式一键复制;自动保存间隔可配)
- `.demo-work/` — 演示作品(测试文本,随时可删)
- `docs/` — 现状与待办(`current/现状.md`)、需求基线(`reference/01-产品定义.md`)、决策记录(`decisions/0001-0014`);历史文档(诊断 00/roadmap/壳重设计系列/审核手册/生态调研/路线偏移与最新进展等)在 `docs/archive/`(逐件索引见 archive/README.md)
- `scripts/check-env.ps1` — 检查 LLM_* 环境变量是否配置

## 下一轮流程（动工前必读）

- 当前待办与优先级见 `docs/current/现状.md` 待办节；设计类改动先入 `docs/decisions/` 按序号定稿，再动工实现。

## 更新通道

- 端点:`https://github.com/sanjiao-orl/final/releases/latest/download/latest.json`(Tauri updater 标准静态 latest.json,启动后台检查,发现新版本即下载校验并走 passive 安装)。
- 发布命令(在仓库根,需 `gh` 已登录 github.com):
  ```bash
  npm run release -- 0.1.1          # 指定版本
  npm run release -- patch          # 或 patch / minor / major 自增
  npm run release -- patch --dry-run # 无副作用演练:只读预检+版本内容内存校验+打印动作计划
  ```
  脚本 `scripts/release.mjs` 先工作树预检(除版本文件外的未提交改动即拦截)→ 同步六处版本号(`shell/src-tauri/tauri.conf.json`、`shell/package.json`、`shell/src-tauri/Cargo.toml`、`core/package.json`、`domain/package.json`、`package-lock.json` 的 core/domain/shell 三段,顺带 `Cargo.lock` 的 app 段;事务化写入——七处新内容全部内存构造并逐项校验通过才落盘,写完由 `scripts/check-versions.mjs` 自检,不一致即中止)→ 带签名私钥跑 `npx tauri build --ci`(仅 NSIS;`core/prompts/` 中文目录名超出 WiX 1252 码页,MSI 已弃)→ 收集 NSIS 与 `.sig` → 生成 `latest.json` → 版本落账(自动 `chore(release): bump vX.Y.Z` + tag + push,幂等)→ 建草稿 release 逐文件 `gh release upload --clobber` 上传(gh 走 rustls,根治 curl/schannel 大文件上传卡死;失败重试,断网修复后重跑同一命令续传)→ 全部传完才发布。
- 护栏(0014):自增算出的版本其本地 tag 已存在即拦截(半途续传请显式指定版本号,如 `npm run release -- 0.2.5`);发版前建议先 `--dry-run` 空跑一遍看动作计划;CI 门禁见 `.github/workflows/ci.yml`(check+test+cargo test,e2e 需真实 key 不进 CI)。
- 签名密钥在仓外 `%USERPROFILE%\.tauri\novel-ws.key`(本仓为空密码;pubkey 已写入 tauri.conf.json,私钥绝不入库)。可用 `TAURI_SIGNING_PRIVATE_KEY_PATH` 覆盖路径,或 `TAURI_SIGNING_PRIVATE_KEY` 直接给密钥内容;密码用 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 版本号改动由脚本自动落账(commit/tag/push),无需手动提交;工作树不干净时脚本会直接拦截。
- 发布记录:v0.1.0 首发(真实更新通道基线);v0.1.1 升级通道闭环验证;v0.1.x 壳 v4 与真实使用反馈修复;v0.2.0 壳 v5;v0.2.1 批一安全修复 + prompt/skill 文件机制;v0.2.2 审计收口 + 批三-1/-2/-3 + 更新体验修复(实机 0.2.1→0.2.2 自动升级验证通过);v0.2.3 铁律回归批(chat 正文一律经 stage_chapter_proposal 进暂存区、设定路由防 manuscript 污染,决策 0012);v0.2.4 碰撞模式/触发式续写/编辑器联动(批一③④⑤,protocol 4);v0.2.5 作者反馈批 R1/R3/R4 + 批一⑥日更手感小包(protocol 6、31 工具)+ 工程护栏批(CI 门禁/release dry-run+事务化/esbuild 落账);v0.2.6 块0 修复批(0822排查 30 条全结:全链超时取消/数据正确性/prompt·skill 口径,bugs.md 台账立账);v0.2.7 块1 理解层供料(对账器/章摘要/发布前质检/list_trash 收口,35 工具,CI windows-latest 首绿);v0.2.8 评审修复 R1 + T9 正文跳转闭环(restore_trash 收口 36 工具、scan_quality 内存修复、四类面板定位钮);v0.2.9 评审 R2 余量批 T10-T14 + 作者实测两条(工具结果信封解包/输出触顶可见);v0.2.10 块 2 前置两小批(DOMPurify 输出净化三入口+promptfoo 行为回归基建,bugs.md 随版归档纪律生效,当前最新)。

## production 打包（sidecar 随安装包分发）

- `npm run build:sidecar`：用 esbuild 把 `core/src/main.ts`、`domain/src/server.ts` 打成单文件 ESM bundle（`core/dist/main.mjs`、`domain/dist/server.mjs`），并把本机 Node 24 运行时复制到 `shell/src-tauri/resources/sidecar/node.exe`（该目录不入库）。
- `cd shell && npx tauri build`：`beforeBuildCommand` 会先构建前端与 sidecar；`bundle.resources` 把 `sidecar/node.exe`、`sidecar/core/main.mjs`、`sidecar/domain/server.mjs` 收进安装包资源目录。
- 发布形态：release 壳从 Tauri resource_dir 拉起 node.exe + core bundle，并通过 `MCP_DOMAIN_CMD` 指向资源目录里的 domain bundle；dev 模式仍走仓库源码 + `tsx`，行为不变。作品目录：dev 为 `<repo>/.demo-work`，prod 为系统应用数据目录下 `.demo-work`。

## 验收口径

- `npm run check` / `npm test`(975 用例:core 240 + domain 347 + shell 388;另 cargo test 17;写作闭环 e2e-workflow 12 步含碰撞闸门与触发式续写,真实 LLM key 在场才跑;行为回归 `npm run promptfoo` 三用例——起草路由/skill 铁律/非正文负向,同样真实 LLM 手动跑;GitHub Actions CI 门禁同口径)
- 每周出口 = 作者用本仓真实写作;不以测试绿为验收

## 已知现象

- **AI 对话"不流式"**:壳全链路是流式的(core 逐帧 SSE → 壳 40ms 批次渲染)。若观感是整段一次性蹦出,多半是 provider/代理端不流式或粗粒度吐——可用 `/v1/dev` 联调页直接观察 SSE 帧间隔验证(免鉴权,浏览器开 `http://127.0.0.1:<port>/v1/dev`)。属供应商行为,壳不兜底。
