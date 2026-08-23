# promptfoo 行为回归（块 2 前置基建，2026-08-23 评审提前项）

**定位**：本地手动回归工具——改 `core/prompts/`（chat.md / skill 措辞即产品行为）或升级 LLM 配置后，跑一遍确认行为语义没回归。与 e2e-workflow 同口径：真实 LLM、不进 CI 门禁。

## 运行

```bash
# 仓库根；需真实 LLM 环境变量（用户级已设则直接跑）
npm run promptfoo
```

`npm run promptfoo` = `npx -y promptfoo@0.122.0 eval -c scripts/promptfoo/promptfooconfig.yaml`（版本钉死在脚本里；首次运行 npx 会联网下载到缓存）。**promptfoo 不进 devDependencies**：它是重依赖 CLI，安装会把 `@types/json-schema` 等提升进根 `node_modules/@types`，ambient 类型全局生效曾把 core 的 `tsc` 打挂（2026-08-23 实证，CI 三连红后修复）——升版本就改脚本里的钉死值。

## 环境变量（与 core/scripts/e2e-workflow.mjs 同口径）

- `LLM_API_KEY`（缺省即报错退出，不静默跳过——手动工具要的就是明确信号）
- `LLM_BASE_URL`、`LLM_MODEL`；可选 `LLM_MODEL_CHEAP`
- 某档位预设余额不足时可用 `LLM_ASSIGN_WRITING/BACKGROUND/REVIEW=<预设id>` 覆盖到可用预设再跑（2026-08-23 首轮验证即用 `OX_ALPHA_FREE` 免费档跑通；行为断言考察的是措辞路由，与模型档位弱相关）

## 结构

- `provider.mjs`：自定义 provider——拉起真实 core（tsx 起 `core/src/main.ts`，含 domain MCP），复制 `.demo-work` 到临时目录作 workDir，POST `/v1/chat` 完整消费 SSE，聚合 `{ text, toolCalls, truncated }` 成 JSON 串供断言。整轮共用一个 core 实例，进程退出自动清理。
- `promptfooconfig.yaml`：用例与断言。首轮覆盖评审口径：**chat 起草路由**（直接指令 → `stage_chapter_proposal`，`write_chapter` 不出现）与 **skill 铁律**（点名 skill → 先 `skill_read` 再提案，正文仍过暂存区）+ 非正文诉求不产生提案的负向用例。

## 断言写法

provider 的 `output` 是 `JSON.stringify({ text, toolCalls: [{ name, args }], truncated })`，javascript 断言里直接：

```yaml
- type: javascript
  value: 'JSON.parse(output).toolCalls.some(t => t.name === "stage_chapter_proposal")'
```

## 扩展

- 新用例：`promptfooconfig.yaml` 加 `tests` 条目（`vars.tier`/`vars.mode` 会透传给 `/v1/chat`）。
- 新断言面（如提案 args 的 kind、正文长度下限）：在 javascript 断言里解 `toolCalls[].args`。
- 块 2 声口批改 skill 措辞前，先把对应行为断言补进来再动文件。
