# AGENTS.md

## 项目
网文连载单作者本地 AI 写作工作台（小说领域的 Cursor）：Windows 桌面、纯本地、无账号、BYOK。人机协同开发，作者=唯一用户与验收人。

## 加载规则
- 日常任务：先读 `docs/current/现状.md`（当前事实/规范/待办的唯一基准）
- 改架构/规范/协议/数据模型时：加读 `docs/reference/` 相关件
- 调研/排查类工作件在 `docs/work/`：只读当前任务点名单件，不全目录加载
- `docs/drafts/` 为未定稿草案，仅作者点名时加载
- 禁止全量加载 `docs/archive/`（历史胶囊，按需单点读）
- 版本号/更新日期不手写，归 git 管
-排查和登记缺陷：docs/current/bugs.md——活跃缺陷台账


## 禁止
-本文档只由作者维护，ai不得改写。

## 协作协议
- 需求模糊或多条实现路径：列 2~3 个方案+推荐项问作者，不脑补
- 每次变更端到端闭环：接口 → 实现 → 消费端 → 可运行的验证凭证
- 最小 diff，拒绝无关重构；实现细节自主，架构边界先问

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **final** (4580 symbols, 14115 relationships, 350 execution flows). Use GitNexus graph tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/final/context` | Codebase overview, check index freshness |
| `gitnexus://repo/final/clusters` | All functional areas |
| `gitnexus://repo/final/processes` | All execution flows |
| `gitnexus://repo/final/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
