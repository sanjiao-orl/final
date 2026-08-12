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

npm run dev:core        # 起 sidecar 核心(打印 port/token,写 core-runtime.local.json,含版本/commit/协议自报)
# 浏览器打开 http://127.0.0.1:<port>/v1/dev → 裸联调页(对话/流式/工具/多会话);协议契约见 docs/decisions/0007

node core/scripts/e2e.mjs   # 真实 LLM e2e(key 在场才跑)
```

## 包结构

- `core/` — sidecar 核心:HTTP+SSE server、AI SDK v7、MCP client、node:sqlite 会话持久化
- `domain/` — MCP 领域服务:结构树(卷/章/场,标题派生)、章节读写(原子写)、搜索、字数统计、章/卷生产与组织(新建/重命名/卷内重排)、历史快照读取
- `shell/` — Tauri 2 + Svelte 5 + TipTap 壳(v3 布局:48px AI 窄条 + 会话/对话/工具/设置多栏,点击/滚轮双切换;多候选浮层 B1、工具卡 B3/B10、快照还原 B4、目标字数 B5、ask/auto/yolo 审批 B6、会话多级挂载 B7、采纳留痕 B8、树搜索/场大纲/拖拽 B9、设置面板;自动保存间隔可配)
- `.demo-work/` — 演示作品(测试文本,随时可删)
- `docs/` — 需求基线(01-产品定义)、旧项目诊断(00)、决策记录(decisions/0001-0007)、路线图(roadmap)、审核手册、壳重设计系列
- `scripts/check-env.ps1` — 检查 LLM_* 环境变量是否配置

## 下一轮流程（动工前必读）

- 动工前先读 `docs/生态调研-AI-SDK.md`（harness 本体 + 社区生态能力盘点，2026-08-09）；
- 基于调研报告做设计（能力取舍须对得上报告结论），**设计定稿先提交，再动工实现**。

## 更新通道

- updater 为占位接入(检查端点指向 `http://127.0.0.1:9/...`,启动即后台检查,失败只记日志不打扰):本仓是自用项目、无发布通道,不构建安装包更新链;后续要对外分发时再接真实端点。

## 验收口径

- `npm run check` / `npm test`(207 用例:core 64 + domain 67 + shell 76)
- 每周出口 = 作者用本仓真实写作;不以测试绿为验收
