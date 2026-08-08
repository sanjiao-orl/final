# 0004 · 数据模型与领域服务（domain MCP）

- 状态：已定稿（2026-08-08）
- 反例：novel-rl 的 6 字段 structure.json 纯目录容器 + 双轨索引（实体对作者亲写章节检索失明）。本仓不引入独立于正文的索引文件。

## 数据模型

- **作品 = 文件夹**；**章 = 一个 `.md`**，frontmatter 携带 `title` / `status` / `pov` / `tags` / `synopsis`；
- **场 = 章内 `###` 三级标题**（借 novelWriter"标题即结构"规范，不借其 GPLv3 代码）；
- **结构树从标题派生，可重建**——任何时刻删光派生状态，扫一遍正文即可恢复；
- `.novel/` 为内部目录（trash / history / 未来索引库留口）；md+frontmatter 起步，索引库接口预留不实现。

## 领域服务形态

domain 包 = **MCP stdio 服务**，core 以 MCP client spawn（缺省 `npx tsx ../domain/src/server.ts`，`MCP_DOMAIN_CMD` 可覆盖）。v1 五工具：

| 工具 | 职责 |
| --- | --- |
| `list_structure` | 卷/章/场结构树（含 frontmatter 元数据） |
| `read_chapter` | 读章节正文 |
| `write_chapter` | 写章节（原子写 tmp+rename） |
| `search_content` | 全稿正文搜索 |
| `word_count` | 字数统计（正文非空白字符） |

## 硬约束

- 路径守卫：`../` 与绝对路径逃逸一律拒绝；
- 原子写：tmp+rename，写一半不留残文件；
- 依赖组合锁定 **zod@4 + @modelcontextprotocol/sdk@1.30**——zod 3.25 会让 tsc OOM，勿回退；
- 已知口径待定：`search_content` 目前连 frontmatter 一起搜，碰结构模块时顺手定口径。

## 落选

- 照搬作者旧结构（大纲/设定/章节/tools 四夹）：作者明确"之前只是凑合用，完整规划还按粗放路线就太弱了"；
- 独立 structure.json 索引：双轨索引是 novel-rl 检索失明的根因，结构必须由正文派生。
