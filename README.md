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
