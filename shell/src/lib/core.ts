/**
 * core.ts —— core sidecar 的 HTTP 客户端：Bearer 鉴权、工具代理（壳的数据面）、
 * 会话读取、/v1/chat SSE 流（fetch + ReadableStream 手工解析，text-delta 经批次器进回调）。
 * 只消费版本化契约（/v1/ 前缀，docs/decisions/0007），不依赖引擎内部类型。
 */
import { DeltaBatcher, parseSseFrames } from './sse.js';
import type { Candidate, QualityFinding, SessionRow, StoredMessage } from './types.js';

/** 协议契约前缀（core 全部业务端点）。 */
const API_PREFIX = '/v1';

/**
 * request 默认超时（毫秒）：与 core 侧确定性工具超时口径协调（30s 量级），
 * 长任务（review / stats 扫描等）由调用方经 opts 覆盖或传显式 signal 取消。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** boot 握手专用短超时：core 进程活着但 HTTP 僵死时启动页能报错而不是永转。 */
const HEALTH_TIMEOUT_MS = 5_000;

/** request 的可选控制（可选参数加法，不影响既有调用）：timeoutMs 覆盖默认超时；signal 由调用方持有用于取消。 */
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 网络层失败（fetch 连不上 / 流中途断连）专用错误：区别于业务 4xx/5xx 响应。
 * 错误信息自带可行动提示（core 可能已退出），让 chat / work 的错误展示不用逐处拼；
 * 业务错误（SSE error 事件、HTTP 状态码）走普通 Error，不带这句。
 */
export class CoreNetworkError extends Error {
  constructor(cause: unknown) {
    const base = cause instanceof Error ? cause.message : String(cause);
    super(`${base}；core 可能已退出，请到设置页重启 core`);
    this.name = 'CoreNetworkError';
  }
}

/**
 * 判定 callTool 报错是否为「工具不存在」：旧版 core 经 /v1/tools/ 代理对未注册工具回
 * 404，错误文案为 `工具不可用: <name>（domain MCP 未连接或工具不存在）`（client 把 body.error
 * 原样抛成普通 Error）。按该文案判定，供新工具新增时的旧版兜底分支使用；
 * 503（MCP 重连中「工具暂不可用」）不算缺失——此时工具其实存在，不应走兜底。
 */
export function isToolMissingError(err: unknown, name: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('工具不可用') && msg.includes(name);
}

/**
 * MCP 信封解包：domain 工具统一走 jsonResult 序列化（{content:[{type:'text', text:'<JSON 字符串>'}]}，
 * 无 outputSchema），core 的 chat SSE tool-result 与历史会话回放里的 result 都是这层裸信封。
 * 识别到信封 → 拼接全部 text 段并尝试 JSON.parse（成功返回解析对象，失败返回拼接文本）；
 * 多段拼接解析失败时退回逐段尝试：恰一段为 JSON 对象 → 返回该对象（domain jsonResult 混排说明文字的形态，
 * trashPathOf 等字段读取依赖此路径不静默失效）、多段均为 JSON 对象 → 返回对象数组、其余返回拼接文本；
 * 非信封形态原样返回（本地工具/未来 structuredContent 等），宁漏勿错。
 */
export function unwrapMcpEnvelope(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return result;
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') return result;
    const c = item as { type?: unknown; text?: unknown };
    if (c.type !== 'text' || typeof c.text !== 'string') return result;
    texts.push(c.text);
  }
  const joined = texts.join('\n');
  try {
    return JSON.parse(joined);
  } catch {
    // 多段拼接不是合法 JSON：逐段兜底，恰一段为 JSON 对象时返回它（trashPathOf 等字段读取不静默失效）
    if (texts.length > 1) {
      const objects: unknown[] = [];
      for (const t of texts) {
        try {
          const p: unknown = JSON.parse(t);
          if (p && typeof p === 'object' && !Array.isArray(p)) objects.push(p);
        } catch {
          // 非该段的形态，跳过
        }
      }
      if (objects.length === 1) return objects[0];
      if (objects.length > 1) return objects;
    }
    return joined;
  }
}

export interface CoreInfo {
  port: number;
  token: string;
  workDir: string;
}

export interface StatsSnapshot {
  date: string;
  words: number;
  prev: { date: string; words: number } | null;
  delta: number | null;
}

export interface DailyStats {
  days: Array<{ date: string; words: number }>;
}

export interface ChatStreamHandlers {
  /** 批次后的文本增量（≤40ms 一条）。 */
  onDelta: (text: string) => void;
  onToolCall?: (call: { id: string; name: string; args: unknown }) => void;
  onToolResult?: (result: { id: string; name: string; result: unknown }) => void;
  /** truncated=true 表示模型输出触顶（finishReason=length），本轮内容不完整。 */
  onDone?: (done: { sessionId: string; messageId: string; truncated?: boolean }) => void;
  onError?: (err: Error) => void;
}

export interface RewriteStreamHandlers {
  /** 批次后的改写文本增量（≤40ms 一条）。 */
  onDelta: (text: string) => void;
  onDone?: (done: { text: string }) => void;
  onError?: (err: Error) => void;
}

export interface ContinueStreamHandlers {
  onText: (text: string) => void;
  onDone?: (done: { text: string }) => void;
  onError?: (err: Error) => void;
}

/** GET /v1/posture 的角色条目（契约镜像，决策 0010）。 */
export interface PosturePersona {
  name: string;
  description: string;
  source: 'app' | 'work';
}

/** GET /v1/posture 的方案条目（契约镜像，决策 0010）；channels 为三通道 → 角色名映射。 */
export interface PostureScheme {
  name: string;
  description: string;
  channels: { chat?: string; rewrite?: string; review?: string };
  source: 'app' | 'work';
}

/** GET /v1/posture 响应（契约镜像，决策 0010）。 */
export interface PostureView {
  personas: PosturePersona[];
  schemes: PostureScheme[];
  activeScheme: string | null;
}

/** GET /v1/llm 的模型池与用途槽真值（契约镜像）。 */
export interface LlmStatus {
  mode: 'presets' | 'legacy';
  presets: Array<{ id: string; baseUrl: string; model: string; apiKeyMasked: string }>;
  assign: { writing?: string; background?: string; review?: string };
  effective: Record<'writing' | 'background' | 'review', { presetId?: string; model?: string; error?: string }>;
  legacy?: { baseUrl: string; model: string; modelCheap: string; apiKeyMasked: string; error?: string };
}

/** POST /v1/review 的贵档审阅发现（契约镜像；severity/category 对齐 domain FindingSeverity/FindingCategory）。 */
export interface ReviewFinding {
  severity: 'BLOCKER' | 'MAJOR' | 'MODERATE' | 'MINOR';
  category?: 'CONT' | 'CANON' | 'VOICE' | 'CRAFT' | 'STRUCT' | 'PACE' | 'REPEAT' | 'META';
  quote: string;
  why: string;
  suggestion?: string;
}

/** POST /v1/summary/generate 的章摘要记录（契约镜像；机检字段冻结由 domain 保证，壳只搬运）。 */
export interface SummaryRecord {
  relPath: string;
  summary: string;
  tension?: number;
  sceneType?: string;
  wordCount?: number;
  generatedAt?: string;
}

/** 裸联调参数记忆用 localStorage key（Tauri 路径不受影响）。 */
export const LS_CORE_TOKEN_KEY = 'novel-core-token';
export const LS_CORE_WORKDIR_KEY = 'novel-core-workdir';

/** 裸联调参数解析源（可注入便于单测；缺省走真实浏览器环境）。 */
export interface BareParamSource {
  query?: URLSearchParams;
  lsGet?: (key: string) => string | null;
  lsSet?: (key: string, value: string) => void;
  prompt?: (text: string) => string | null;
}

/**
 * 解析裸联调连接参数（token/workDir）：query 优先（向后兼容）→ localStorage 记忆 →
 * 用户输入（window.prompt 并写入 localStorage）。Tauri 环境不走此函数。
 */
export function resolveBareParam(
  name: string,
  lsKey: string,
  promptText: string,
  src: BareParamSource = {},
): string | undefined {
  const query = src.query ?? (typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams());
  const lsGet = src.lsGet ?? ((k: string) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null));
  const lsSet = src.lsSet ?? ((k: string, v: string) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
  });
  const prompt = src.prompt ?? ((t: string) => (typeof window !== 'undefined' ? window.prompt(t) : null));

  const fromQuery = query.get(name);
  if (fromQuery) return fromQuery;
  const fromLs = lsGet(lsKey);
  if (fromLs) return fromLs;
  const fromUser = prompt(promptText);
  if (fromUser) {
    lsSet(lsKey, fromUser);
    return fromUser;
  }
  return undefined;
}

export class CoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit, opts?: RequestOptions): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    // 调用方显式 signal（如 review 取消）：透传进内部 controller，超时与取消共用一条 abort 通道
    const onOuterAbort = (): void => ac.abort(opts?.signal?.reason);
    if (opts?.signal) {
      if (opts.signal.aborted) onOuterAbort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, {
          ...init,
          signal: ac.signal,
          headers: { Authorization: `Bearer ${this.token}`, ...init?.headers },
        });
      } catch (err) {
        // 调用方取消 / 超时：抛清晰错误（区别于连不上的网络层错误）
        if (opts?.signal?.aborted) throw new Error('请求已取消');
        if (timedOut) throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        // 连不上 / DNS 失败等网络层错误：带可行动提示（core 可能已退出）
        throw new CoreNetworkError(err);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        // 响应体读取阶段被取消/超时中断：同上抛清晰错误；其余（空响应等）按原口径回落 {}
        if (opts?.signal?.aborted) throw new Error('请求已取消');
        if (timedOut) throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        void err;
        body = {};
      }
      if (!res.ok) {
        const msg = (body as { error?: string }).error ?? `${res.status} ${res.statusText}`;
        throw new Error(msg);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
      if (opts?.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async health(): Promise<{ ok: boolean; version: string; protocol?: number }> {
    // boot 握手走短超时：HTTP 僵死时启动页 5s 内报错，不再永转
    return this.request(`${API_PREFIX}/health`, undefined, { timeoutMs: HEALTH_TIMEOUT_MS });
  }

  /** 调 domain 工具（经 core 代理）。失败抛出带服务端 message 的 Error。
   *  长任务工具（scan_quality / word_count 等全量遍历）可传 opts 放大超时或带取消 signal。 */
  callTool<T>(name: string, args: Record<string, unknown>, opts?: RequestOptions): Promise<T> {
    return this.request<T>(`${API_PREFIX}/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }, opts);
  }

  recordStatsSnapshot(workDir: string, opts?: RequestOptions): Promise<StatsSnapshot> {
    return this.request(`${API_PREFIX}/stats/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    }, opts);
  }

  getDailyStats(workDir: string): Promise<DailyStats> {
    return this.request(`${API_PREFIX}/stats/daily?workDir=${encodeURIComponent(workDir)}`);
  }

  /** 当前 core 实际生效的模型池、用途分配与三档模型。 */
  getLlm(): Promise<LlmStatus> {
    return this.request(`${API_PREFIX}/llm`);
  }

  /** 贵档冷读审阅当前章（一次性 JSON，非 SSE）；persisted.ids 与 findings 同序（落盘后的 CR id）。
   *  persona 可选（决策 0010）：激活方案的审阅通道角色名，无激活传 undefined 即不带。 */
  review(
    workDir: string,
    chapterRelPath: string,
    persona?: string,
    opts?: RequestOptions,
  ): Promise<{ findings: ReviewFinding[]; persisted?: { appended: number; ids: string[] } }> {
    return this.request(`${API_PREFIX}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, chapterRelPath, ...(persona ? { persona } : {}) }),
    }, opts);
  }

  /** 角色与方案（GET /v1/posture，决策 0010）：personas/schemes/activeScheme；workDir 省略时不筛。 */
  getPosture(workDir?: string): Promise<PostureView> {
    const q = workDir ? `?workDir=${encodeURIComponent(workDir)}` : '';
    return this.request(`${API_PREFIX}/posture${q}`);
  }

  /** 会话列表；scope 传入时按归属过滤（''=无归属讨论，章 relPath=章节内讨论）。 */
  listSessions(scope?: string): Promise<{ sessions: SessionRow[] }> {
    const q = scope === undefined ? '' : `?scope=${encodeURIComponent(scope)}`;
    return this.request(`${API_PREFIX}/sessions${q}`);
  }

  sessionMessages(id: string): Promise<{ sessionId: string; messages: StoredMessage[] }> {
    return this.request(`${API_PREFIX}/sessions/${encodeURIComponent(id)}`);
  }

  /** 暂存候选列表；status / chapter 过滤可组合。 */
  listCandidates(filter: { status?: string; chapter?: string } = {}): Promise<{ candidates: Candidate[] }> {
    const params = new URLSearchParams();
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.chapter !== undefined) params.set('chapter', filter.chapter);
    const q = params.toString();
    return this.request(`${API_PREFIX}/candidates${q ? '?' + q : ''}`);
  }

  createCandidate(c: {
    chapter: string;
    original: string;
    proposed: string;
    instruction?: string;
    kind?: 'replace' | 'append' | 'replace_all';
    sessionId?: string;
  }): Promise<{ candidate: Candidate }> {
    return this.request(`${API_PREFIX}/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
  }

  patchCandidate(
    id: string,
    patch: { status?: string; proposed?: string; instruction?: string },
  ): Promise<{ candidate: Candidate }> {
    return this.request(`${API_PREFIX}/candidates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  /** 为指定章生成/重建摘要（POST /v1/summary/generate；LLM 活，120s 超时）。调用方 fire-and-forget。 */
  generateSummary(workDir: string, relPath: string): Promise<{ ok: boolean; frozen: boolean; record: SummaryRecord }> {
    return this.request(`${API_PREFIX}/summary/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, relPath }),
    }, { timeoutMs: 120_000 });
  }

  /** 章节质检=发布前风险提示（POST /v1/quality/check；便宜模型 LLM 活，180s 超时），不自动改、不拦截流转。 */
  qualityCheck(workDir: string, relPath: string): Promise<{
    ok: boolean;
    chapterTitle?: string;
    truncated?: boolean;
    findings: QualityFinding[];
  }> {
    return this.request(`${API_PREFIX}/quality/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, relPath }),
    }, { timeoutMs: 180_000 });
  }

  /** POST /v1/chat 的 SSE 流：手工解析帧，text-delta 经 DeltaBatcher 批次后才进 onDelta。 */
  async chatStream(
    body: {
      sessionId?: string;
      text: string;
      workDir?: string;
      scope?: string;
      tier?: 'writing' | 'background';
      /** 章节挂载（scope=ch:…）时携带的当前章 relPath。 */
      chapter?: string;
      /** 激活方案的角色名（决策 0010）；无激活不带。 */
      persona?: string;
      /** 碰撞模式（批一③）：开启时 core 按 方案/漏洞/反方/裁决 四节输出。 */
      mode?: 'collide';
    },
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.postSse(`${API_PREFIX}/chat`, body, handlers.onDelta, (event, data, flush) => {
      switch (event) {
        case 'tool-call':
          handlers.onToolCall?.(data as { id: string; name: string; args: unknown });
          break;
        case 'tool-result':
          handlers.onToolResult?.(data as { id: string; name: string; result: unknown });
          break;
        case 'done':
          flush();
          handlers.onDone?.(data as { sessionId: string; messageId: string; truncated?: boolean });
          break;
        case 'error': {
          flush();
          const msg = (data as { message?: string }).message ?? '服务端错误';
          handlers.onError?.(new Error(msg));
          break;
        }
      }
    }, signal);
  }

  /** POST /v1/rewrite 的 SSE 流：纯改写（无工具、不落库），done 带完整改写文本。 */
  async rewriteStream(
    body: { workDir?: string; original: string; instruction: string; persona?: string },
    handlers: RewriteStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.postSse(`${API_PREFIX}/rewrite`, body, handlers.onDelta, (event, data, flush) => {
      if (event === 'done') {
        flush();
        handlers.onDone?.({ text: String((data as { text?: string }).text ?? '') });
      } else if (event === 'error') {
        flush();
        const msg = (data as { message?: string }).message ?? '服务端错误';
        handlers.onError?.(new Error(msg));
      }
    }, signal);
  }

  /** POST /v1/continue 的 SSE 流：续写结果只进入暂存区候选。 */
  async continueText(
    body: { context: string; instruction?: string; workDir?: string },
    handlers: ContinueStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.postSse(`${API_PREFIX}/continue`, body, handlers.onText, (event, data, flush) => {
      if (event === 'done') {
        flush();
        handlers.onDone?.({ text: String((data as { text?: string }).text ?? '') });
      } else if (event === 'error') {
        flush();
        const msg = (data as { message?: string }).message ?? '服务端错误';
        handlers.onError?.(new Error(msg));
      }
    }, signal);
  }

  /** SSE POST 共用管道：fetch + ReadableStream 手工解析帧，text-delta 批次进 onDelta。 */
  private async postSse(
    path: string,
    body: unknown,
    onDelta: (text: string) => void,
    onEvent: (event: string, data: unknown, flush: () => void) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      // 连不上 / DNS 失败等网络层错误：带可行动提示（core 可能已退出）
      throw new CoreNetworkError(err);
    }
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `请求失败: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const batcher = new DeltaBatcher(onDelta);
    let aborted = false;
    let sawTerminal = false; // 收到 done/error 帧才算干净收尾
    const onAbort = (): void => {
      aborted = true;
      reader.cancel().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          // 流中途断连（网络层）：带可行动提示（core 可能已退出）
          throw new CoreNetworkError(err);
        }
        const { done, value } = chunk;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buf);
        buf = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.event === 'text-delta') {
            const delta = frame.data as { text?: string; delta?: string };
            batcher.push(String(delta.text ?? delta.delta ?? ''));
          } else {
            if (frame.event === 'done' || frame.event === 'error') sawTerminal = true;
            onEvent(frame.event, frame.data, () => batcher.flushNow());
          }
        }
        if (aborted) break;
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      batcher.dispose(); // 兜底 flush，末尾不丢 token
    }
    // 干净断尾（core 关连但没发 done/error）不算成功：静默当成功会让调用方卡死零信号
    if (!aborted && !sawTerminal) {
      throw new Error('SSE 流在完成前被关闭（未收到 done/error 帧）');
    }
  }
}

export interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export function tauriInvoke(): TauriInternals['invoke'] | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: TauriInternals['invoke'] } };
  return w.__TAURI_INTERNALS__?.invoke?.bind(w.__TAURI_INTERNALS__);
}

/**
 * 连接 core：Tauri 环境走 core_info 命令（壳进程已拉起 sidecar），
 * 浏览器裸联调走 ?corePort=&coreToken=&workDir=（与 /dev 页同级的调试通道）；
 * token/workDir 缺省时回落到 localStorage 记忆，再缺则 prompt 用户输入并记忆。
 */
export async function connectCore(): Promise<{ client: CoreClient; workDir: string }> {
  const invoke = tauriInvoke();
  if (invoke) {
    const info = await waitCoreInfo(invoke);
    return {
      client: new CoreClient(`http://127.0.0.1:${info.port}`, info.token),
      workDir: info.workDir,
    };
  }
  const q = new URLSearchParams(window.location.search);
  const port = q.get('corePort');
  const token = resolveBareParam('coreToken', LS_CORE_TOKEN_KEY, '请粘贴 core 的访问令牌（将保存在本地，下次自动读取）：', { query: q });
  const workDir = resolveBareParam('workDir', LS_CORE_WORKDIR_KEY, '请填写作品目录绝对路径（将保存在本地，下次自动读取）：', { query: q });
  if (port && token && workDir) {
    return { client: new CoreClient(`http://127.0.0.1:${port}`, token), workDir };
  }
  throw new Error('缺少 core 连接信息：请在 Tauri 壳中打开，或带 ?corePort=&coreToken=&workDir= 参数');
}

/** 壳启动早于 sidecar 就绪，轮询 core_info 最多 ~15s。
 *  core_info 对 Failed 终态回「core sidecar 启动失败: …」（lib.rs CoreState::Failed）——
 *  终态不会自愈，立即抛错而不是陪跑满 15s（评审 P3：Failed 终态仍轮询满 15s 才报错）。 */
const CORE_FAILED_PREFIX = 'core sidecar 启动失败';

async function waitCoreInfo(invoke: TauriInternals['invoke']): Promise<CoreInfo> {
  let lastError: unknown;
  for (let i = 0; i < 75; i++) {
    try {
      return await invoke<CoreInfo>('core_info');
    } catch (err) {
      lastError = err;
      if (String(err).startsWith(CORE_FAILED_PREFIX)) throw new Error(String(err));
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`等待 core sidecar 超时: ${String(lastError)}`);
}