# novel-ws(小说写作工作台)

网文连载单作者的本地 AI 写作工作台。架构与纪律见 `AGENTS.md`。

## 快速开始

```bash
npm install

# 配置模型(三要素缺一不可,已写入用户级环境变量,新开终端即生效)
#   LLM_BASE_URL  https://opencode.ai/zen/v1(OpenCode Zen,复用 OPENCODE_API_KEY)
#   LLM_API_KEY   OpenCode Zen key
#   LLM_MODEL     deepseek-v4-flash-free(Zen 免费档;付费模型余额不足会 402,需到 opencode.ai 充值后改用)
#   LLM_MODEL_CHEAP  (可选)后台档模型,缺省回退 LLM_MODEL

npm run dev:core        # 起 sidecar 核心(打印 port/token,写 core-runtime.local.json)
# 浏览器打开 http://127.0.0.1:<port>/dev → 裸联调页(对话/流式/工具/多会话)

node core/scripts/e2e.mjs   # 真实 LLM e2e(key 在场才跑)
```

## 包结构

- `core/` — sidecar 核心:HTTP+SSE server、AI SDK v7、MCP client、node:sqlite 会话持久化
- `domain/` — MCP 领域服务:结构树(卷/章/场,标题派生)、章节读写(原子写)、搜索、字数统计
- `shell/` — Tauri 壳(第 2 周动工,当前为空)
- `.demo-work/` — 演示作品(测试文本,随时可删)
- `docs/` — 需求基线(01-产品定义)、旧项目诊断(00)、决策记录(decisions/0001-0004)、路线图(roadmap)
- `scripts/check-env.ps1` — 检查 LLM_* 环境变量是否配置

## 验收口径

- `npm run check` / `npm test`(50 用例)
- 每周出口 = 作者用本仓真实写作;不以测试绿为验收
