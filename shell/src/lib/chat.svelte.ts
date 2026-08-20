/**
 * chat.svelte.ts —— AI 讨论：任意层级挂载（B7：作品根/卷/章稳定 id）、会话搜索/重命名/归档、
 * 工具调用卡片化数据（B3/B10）、危险工具分级审批联动（B6）。
 *
 * scope 编码（壳私有约定，core 只存不解释）：''=无归属；`ch:<章 frontmatter id>`=章节内
 * （章重排改名不失效）；`vol:<卷目录名>`=卷内；`work`=作品根。
 * 会话重命名/归档是壳产品逻辑（core 不为此加逻辑）：overlay 存 localStorage，
 * 改名覆盖显示标题、归档从列表隐藏。
 */
import type { CoreClient } from './core.js';
import type { ChapterNode, SessionRow } from './types.js';
import { approval } from './approval.svelte.js';
import { candidates } from './candidates.svelte.js';
import { settings } from './settings.svelte.js';
import { snapshot } from './snapshot.svelte.js';
import { scheme } from './scheme.svelte.js';
import { work } from './work.svelte.js';

export type ToolState = 'running' | 'done' | 'pending' | 'rejected';

export interface ToolLine {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  state: ToolState;
}

export interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  content: string;
  tools?: ToolLine[];
}

/** D3 分组（按 assistant 消息聚合）：组头=该轮用户消息前 20 字，key=该 assistant 消息下标（单会话内稳定）。 */
export interface ToolGroup {
  /** 该 assistant 消息在 messages 里的下标（字符串化）—— ChatColumn 摘要跳转与 ToolsColumn 定位共用。 */
  key: string;
  /** 触发该轮工具调用的用户消息前 20 字（无 user 时为空串）。 */
  userPrompt: string;
  tools: ToolLine[];
  /** 该组是否含未完成工具（running/pending）—— 摘要行的脉冲点与"正在调用"提示用。 */
  hasPending: boolean;
}

/** 会话 overlay（壳私有：重命名/归档，core 会话库不动）。 */
interface SessionMeta {
  title?: string;
  archived?: boolean;
}

const META_KEY = 'novel.sessionMeta';

function loadMeta(): Record<string, SessionMeta> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<string, SessionMeta>;
  } catch {
    return {};
  }
}

export class ChatStore {
  /** 当前讨论归属（编码见文件头）。 */
  scope = $state('');
  /** 当前归属下的会话列表（最近更新在前）。 */
  sessions = $state<SessionRow[]>([]);
  sessionId = $state<string | null>(null);
  messages = $state<ChatMsg[]>([]);
  streaming = $state(false);
  /** 会话列表搜索词（B7）。 */
  searchText = $state('');
  /** 重命名中的会话 id（行内输入态）。 */
  renamingId = $state<string | null>(null);
  renameDraft = $state('');
  /** D3：ChatColumn 摘要跳转请求 ToolsColumn 定位的组 key（下标字符串）。ToolsColumn 消费后清空。 */
  focusToolsGroupKey = $state<string | null>(null);
  /** 发送档位（D4）：writing=写作档模型，background=背景档（便宜模型，杂活用）。持久化 localStorage。 */
  tier = $state<'writing' | 'background'>(
    typeof localStorage !== 'undefined' && localStorage.getItem('chat.tier') === 'background' ? 'background' : 'writing',
  );
  /**
   * 对话草稿持久（反馈#1：关栏/切存区不再丢未发送文字）。键 = `session:<sessionId>`（有会话）
   * 或 `scope:<scope>`（未建新会话）；ChatColumn composer 与 store 共用 currentDraftKey() 定位。
   */
  draftMap = $state<Record<string, string>>({});

  /** 当前草稿键：有会话挂会话，无会话挂归属 scope（两者变化时草稿随键切换）。 */
  currentDraftKey(): string {
    if (this.sessionId) return `session:${this.sessionId}`;
    return `scope:${this.scope}`;
  }

  getDraft(key: string): string {
    return this.draftMap[key] ?? '';
  }

  setDraft(key: string, text: string): void {
    this.draftMap[key] = text;
  }

  setTier(t: 'writing' | 'background'): void {
    this.tier = t;
    try {
      localStorage.setItem('chat.tier', t);
    } catch {
      // 隐私模式等：内存态生效即可
    }
  }

  /** 显示层会话列表：归档隐藏 + 搜索过滤。 */
  visibleSessions = $derived.by(() => {
    const meta = loadMeta();
    const q = this.searchText.trim().toLowerCase();
    return this.sessions.filter((s) => {
      const m = meta[s.id];
      if (m?.archived) return false;
      if (!q) return true;
      const title = this.sessionTitle(s);
      return title.toLowerCase().includes(q) || s.scope.includes(q);
    });
  });

  private client!: CoreClient;
  private meta: Record<string, SessionMeta> = loadMeta();
  /** 工具调用的起始时间（毫秒）—— 用 WeakMap 不污染 ToolLine 形状（保留现有 toEqual 断言语义）。
   *  key 为 messages 里的 ToolLine proxy 对象引用；切存区 / 新会话旧 key 自动 GC。 */
  private toolStartTimes = new WeakMap<object, number>();

  /** 查工具调用起始时间；未记录返回 undefined（历史会话 / 跨会话迁移时）。 */
  toolStarted(tool: ToolLine): number | undefined {
    return this.toolStartTimes.get(tool as object);
  }

  /** D3 工具调用分组（按 assistant 消息聚合），下游 ChatColumn 摘要 / ToolsColumn 列表共用。 */
  toolGroups = $derived.by(() => {
    const out: ToolGroup[] = [];
    let lastUser = '';
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      if (m.role === 'user') lastUser = m.content;
      if (m.role === 'assistant' && m.tools && m.tools.length > 0) {
        out.push({
          key: String(i),
          userPrompt: lastUser.slice(0, 20),
          tools: m.tools,
          hasPending: m.tools.some((t) => t.state === 'pending' || t.state === 'running'),
        });
      }
    }
    return out;
  });

  init(client: CoreClient): void {
    this.client = client;
  }

  private saveMeta(): void {
    localStorage.setItem(META_KEY, JSON.stringify(this.meta));
  }

  sessionTitle(s: SessionRow): string {
    return this.meta[s.id]?.title || s.title || '（未命名）';
  }

  /** 当前流式请求的 AbortController：用于 UI 主动取消（聊天栏「停止」按钮）。 */
  private streamAbort: AbortController | null = null;
  /** 最后一次流式是否被用户主动取消（聊天栏给中断消息打标）。 */
  abortedLastStream = $state(false);

  /** 中断当前流式：fetch 收到 abort 后服务连接断开，UI 不再展示残留 delta。
   *  已落库的 assistant 占位 message 保留并打上「已中断」标记，方便用户接着发。 */
  abortStream(): void {
    if (!this.streaming) return;
    this.streamAbort?.abort();
  }

  /** 当前挂载章节点（scope='ch:' 前缀）：按 frontmatter 稳定 id 或 relPath 解析；解析不到返回 null。 */
  private chapterNodeForScope(): ChapterNode | null {
    if (!this.scope.startsWith('ch:')) return null;
    const key = this.scope.slice(3);
    return work.findChapterById(key) ?? work.findChapter(key);
  }

  /** 当前挂载点的人类可读标签（会话栏/对话栏标题用）。 */
  scopeLabel(): string {
    if (this.scope === '') return '无归属';
    if (this.scope === 'work') return '作品根';
    if (this.scope.startsWith('vol:')) return this.scope.slice(4);
    if (this.scope.startsWith('ch:')) {
      const node = this.chapterNodeForScope();
      return node?.title ?? '本章';
    }
    return this.scope;
  }

  /** 切换讨论存区：清空现场，加载该归属的会话，自动打开最近一个。 */
  async setScope(scope: string): Promise<void> {
    if (scope === this.scope && this.sessionId !== null) return;
    this.scope = scope;
    this.sessionId = null;
    this.messages = [];
    approval.resetSessionAllowed();
    await this.loadSessions();
    const latest = this.visibleSessions[0];
    if (latest) await this.openSession(latest.id);
  }

  async loadSessions(): Promise<void> {
    try {
      const r = await this.client.listSessions(this.scope);
      this.sessions = r.sessions;
    } catch {
      this.sessions = []; // 列表失败不挡聊天主链路
    }
  }

  /** 打开历史会话（重启恢复 / 列表点选）。 */
  async openSession(id: string): Promise<void> {
    this.sessionId = id;
    this.renamingId = null;
    approval.resetSessionAllowed();
    try {
      const r = await this.client.sessionMessages(id);
      this.messages = r.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tools: (m.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, args: t.args, state: 'done' as ToolState })),
      }));
    } catch (err) {
      this.messages = [
        { role: 'error', content: `会话读取失败：${err instanceof Error ? err.message : String(err)}` },
      ];
    }
  }

  newSession(): void {
    this.sessionId = null;
    this.messages = [];
    approval.resetSessionAllowed();
  }

  /** B7 重命名：行内编辑态进入 / 提交 / 取消。 */
  startRename(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    this.renamingId = id;
    this.renameDraft = s ? this.sessionTitle(s) : '';
  }

  commitRename(): void {
    if (!this.renamingId) return;
    const title = this.renameDraft.trim();
    if (title) {
      this.meta[this.renamingId] = { ...this.meta[this.renamingId], title };
      this.saveMeta();
    }
    this.renamingId = null;
  }

  cancelRename(): void {
    this.renamingId = null;
  }

  /** B7 归档：从列表隐藏（记录与消息仍在 core 库中）。 */
  archiveSession(id: string): void {
    this.meta[id] = { ...this.meta[id], archived: true };
    this.saveMeta();
    if (this.sessionId === id) this.newSession();
  }

  /**
   * B6 审批裁决：允许一次 / 允许本会话 / 拒绝（拒绝走补偿还原）。
   * callId 可选：审批卡按 active 裁决；工具卡上的拒绝按钮按本卡 callId 裁决，避免误拒最旧卡。
   * 拒绝语义（core 在事件流内已执行，壳做撤销）：write_chapter → 事前快照还原；
   * delete_chapter → 从 .novel/trash/ 读回原内容写回原路径；export_txt → 提示文件保留路径。
   */
  async resolveApproval(verdict: 'once' | 'session' | 'reject', callId?: string): Promise<void> {
    const req = callId ? approval.pending.find((p) => p.callId === callId) : approval.active;
    if (!req) return;
    if (verdict === 'reject') {
      await this.rejectApproval(req);
    } else {
      this.markToolResolved(req.callId, 'done');
      // B6 放行 AI 直写当前打开章：core 已落盘，编辑器以磁盘为准重载，避免旧文覆盖 AI 写入。
      if (
        req.name === 'write_chapter' &&
        typeof req.args.relPath === 'string' &&
        work.current?.relPath === req.args.relPath
      ) {
        await work.reloadCurrent();
      }
    }
    approval.resolve(req.callId, verdict);
  }

  /** 把指定工具行推进到终态（放行 done / 拒绝 rejected）。 */
  private markToolResolved(callId: string, state: ToolState): void {
    for (const m of this.messages) {
      for (const t of m.tools ?? []) {
        if (t.id === callId) t.state = state;
      }
    }
  }

  private async rejectApproval(req: { callId: string; name: string; args: Record<string, unknown> }): Promise<void> {
    // 该调用对应的工具卡落定为 rejected（结果已到则保留结果就地审阅）
    this.markToolResolved(req.callId, 'rejected');
    try {
      if (req.name === 'write_chapter') {
        const rel = typeof req.args.relPath === 'string' ? req.args.relPath : '';
        if (rel) {
          const ok = await snapshot.restoreLatest(rel);
          if (ok) work.notice = `已拒绝 AI 直写并还原 ${rel}（事前快照）`;
        }
      } else if (req.name === 'delete_chapter') {
        const rel = typeof req.args.relPath === 'string' ? req.args.relPath : '';
        if (rel) {
          // 删除是软删：从 trash 里找回最新一份同名内容写回原路径（read_chapter 特许读 .novel/trash/ 内的 .md）
          const trashPath = this.trashPathOf(req.callId, rel);
          if (trashPath) {
            const r = await this.client.callTool<{ content: string }>('read_chapter', {
              workDir: work.workDir,
              relPath: trashPath,
            });
            await this.client.callTool('write_chapter', {
              workDir: work.workDir,
              relPath: rel,
              content: r.content,
            });
            await work.loadStructure();
            work.notice = `已拒绝 AI 删章并找回 ${rel}（trash 副本还原，trash 里仍留备份）`;
          } else {
            work.notice = `已拒绝 AI 删章；未找到 trash 副本，${rel} 仍在回收站`;
          }
        }
      } else if (req.name === 'export_txt') {
        work.notice = '已拒绝 AI 导出；如已生成导出文件，保留在作品文件夹根，可自行删除';
      }
    } catch (err) {
      work.error = `拒绝补偿失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 找该调用的工具结果里的 trashPath（delete_chapter 返回 { trashPath }）。 */
  private trashPathOf(callId: string, rel: string): string | null {
    for (const m of this.messages) {
      for (const t of m.tools ?? []) {
        if (t.id !== callId || t.state === 'rejected') continue;
        const r = t.result as { trashPath?: string } | null | undefined;
        if (r?.trashPath) return r.trashPath;
      }
    }
    // 结果未到（流中断）：按 relPath 拍平推导 trash 文件名不可靠，放弃自动找回
    void rel;
    return null;
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.streaming) return;
    this.abortedLastStream = false;
    // 草稿键与内容在发送前捕获：流式期间用户可改写草稿，成功后仅当内容未变才清（见下方）
    const draftKey = this.currentDraftKey();
    const draftAtSend = this.draftMap[draftKey];
    this.messages.push({ role: 'user', content: trimmed });
    this.messages.push({ role: 'assistant', content: '', tools: [] });
    const idx = this.messages.length - 1;
    this.streaming = true;
    const scopeAtSend = this.scope; // 流式期间切存区：结果不回写现场，但服务端会话已完整落库
    const ac = new AbortController();
    this.streamAbort = ac;
    try {
      // 批三-3：章节挂载（scope=ch:…）时把当前章 relPath 带给 core（账本切片/章上下文用）；解析不到不带。
      const chapterNode = this.chapterNodeForScope();
      // 决策 0010：激活方案映射到 chat 通道的 persona，无激活/无映射不带。
      const persona = scheme.channelPersona('chat');
      const body = this.sessionId
        ? { sessionId: this.sessionId, text: trimmed, workDir: work.workDir, tier: this.tier, ...(chapterNode ? { chapter: chapterNode.relPath } : {}), ...(persona ? { persona } : {}) }
        : { text: trimmed, workDir: work.workDir, scope: this.scope, tier: this.tier, ...(chapterNode ? { chapter: chapterNode.relPath } : {}), ...(persona ? { persona } : {}) };
      await this.client.chatStream(body, {
        onDelta: (t) => {
          const m = this.messages[idx];
          if (m) m.content += t;
        },
        onToolCall: (c) => {
          const m = this.messages[idx];
          if (!m) return;
          // B6 审批门：危险工具按当前模式裁决（ask 弹卡 / auto 查会话放行表 / yolo 直放）。
          // 工具实际已在 core 内执行完（约束见 approval.ts 头注）；卡先显挂起，等裁决后落定。
          const args = (c.args ?? {}) as Record<string, unknown>;
          const decision = approval.decide(c.id, c.name, args, settings.approvalMode);
          const tool: ToolLine = {
            id: c.id,
            name: c.name,
            args: c.args,
            state: decision === 'pending' ? 'pending' : 'running',
          };
          this.toolStartTimes.set(tool, Date.now()); // 记录起始时间（D3 工具卡"耗时"用）
          m.tools?.push(tool);
        },
        onToolResult: (r) => {
          const m = this.messages[idx];
          const tool = m?.tools?.find((t) => t.id === r.id);
          if (!tool) return;
          tool.result = r.result;
          if (tool.state !== 'pending' && tool.state !== 'rejected') tool.state = 'done';
        },
        onDone: (d) => {
          if (this.scope === scopeAtSend) {
            this.sessionId = d.sessionId;
            void this.loadSessions(); // 新会话进列表/标题排序刷新
          }
        },
        onError: (err) => {
          this.messages.push({ role: 'error', content: `服务端错误：${err.message}` });
        },
      }, ac.signal);
      // 流式正常完成（非中断）：若占位无内容也无工具行则清理
      if (!ac.signal.aborted) {
        const m = this.messages[idx];
        const tools = m?.tools ?? [];
        if (m && m.content === '' && tools.length === 0) {
          this.messages.splice(idx, 1);
        }
        // 任务3（反馈#6）：AI 写完自动刷新结构树/当前章，免按 F5；失败静默 + console.warn
        await this.refreshAfterTools(tools);
        // 新会话建立（键从 scope:<scope> 切到 session:<id>）：把流式期间用户在输入框新写的草稿
        // 迁移到新会话键，避免键切换瞬间正在输入的文字从视野消失。
        if (this.sessionId && draftKey !== this.currentDraftKey() && draftKey.startsWith('scope:')) {
          const pending = this.draftMap[draftKey];
          if (pending && pending !== '') {
            this.draftMap[this.currentDraftKey()] = pending;
            delete this.draftMap[draftKey];
          }
        }
        // 任务1（反馈#1）：发送成功后清该键草稿（流式期间用户若已改写新内容则保留）
        if (this.draftMap[draftKey] === draftAtSend) delete this.draftMap[draftKey];
      } else {
        this.abortedLastStream = true;
      }
    } catch (err) {
      if (ac.signal.aborted) {
        this.abortedLastStream = true;
      } else {
        this.messages.push({
          role: 'error',
          content: `请求失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      this.streaming = false;
      this.streamAbort = null;
    }
  }

  /**
   * 任务3（反馈#6）：AI 写完自动刷新。流式正常结束后按本轮已落定（done）的工具：
   * - 结构变更工具（建/改/删/移卷章）→ loadStructure 刷结构树；
   * - write_chapter（命中任意章，字数会变）→ 同样 loadStructure；
   * - write_chapter 命中当前打开章 → 再 reloadCurrent（磁盘为准重载编辑器，参照 snapshot.restore）。
   * pending/rejected 不在此处理：pending 等审批裁决路径（resolveApproval/rejectApproval）已各自刷新。
   * 刷新失败静默 catch + console.warn：不该炸对话。
   */
  private async refreshAfterTools(tools: ToolLine[]): Promise<void> {
    if (tools.length === 0 || !work.workDir) return;
    const STRUCTURE_TOOLS = new Set([
      'create_volume',
      'rename_volume',
      'delete_volume',
      'create_chapter',
      'rename_chapter',
      'delete_chapter',
      'move_chapter',
      'move_volume',
    ]);
    const done = tools.filter((t) => t.state === 'done');
    const changedStructure = done.some((t) => STRUCTURE_TOOLS.has(t.name));
    const wroteChapter = done.some((t) => t.name === 'write_chapter');
    const wroteCurrent = done.some((t) => {
      if (t.name !== 'write_chapter') return false;
      const rel = (t.args as { relPath?: string } | null | undefined)?.relPath;
      return typeof rel === 'string' && work.current?.relPath === rel;
    });
    // 批三-3：账本被 AI 改过（ledger_upsert）→ 上下文栏按当前口径（随章切片/全书）重拉。
    const touchedLedger = done.some((t) => t.name === 'ledger_upsert');
    // chat 正文进暂存区：stage_chapter_proposal 落定 → 重拉暂存区（计数/抽屉即时刷新）。
    const stagedProposal = done.some((t) => t.name === 'stage_chapter_proposal');
    try {
      if (changedStructure || wroteChapter) await work.loadStructure();
      if (wroteCurrent) await work.reloadCurrent();
      if (touchedLedger) void snapshot.refreshLedger();
      if (stagedProposal) void candidates.load();
    } catch (err) {
      console.warn('AI 写完自动刷新失败：', err);
    }
  }
}

export const chat = new ChatStore();
