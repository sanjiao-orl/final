/**
 * inbox.ts —— 统一裁决收件箱（reference/05 §裁决回路；4.2 薄切片批，承诺·伏笔窄域先行）。
 *
 * 收件箱 = md 文件（人审内容留 md 纪律），路径白名单 `.novel/` 根下 .md（复用 ledger 白名单口径）。
 * 每条提案以 HTML 注释定界块存储（内嵌 serializeProposal 完整 md，round-trip 由 parseProposal 保证）；
 * 预筛→扫描→提案 的产物入箱，裁决改写块状态：
 * - adopt：权限面复核（写闸）→ upsertLedger 落账 → 回读验证目标条目在位（修复过闸，铁律 4；DELETE 验消失）；
 * - discard：必带理由枚举，「有意延后」一等公民（新预计卷=卷锚重报依据）。
 * 追加幂等：pending 态中同 (action,targetKey) 去重，重跑扫描不产生重复项；「误报」裁决的键永久抑制再入（重报锚语义）。
 * 写入安全：写前 CAS 复核 + 原子写（防并发互相覆盖/写一半损坏）；路径守卫排除账本与声口保留文件
 * （防收件箱全文重组覆写事实源）。
 */
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { assertWorkDir, atomicWrite, resolveInsidePosix } from './fsutil.js';
import {
  adoptProposal,
  discardProposal,
  parseProposal,
  serializeProposal,
  validateProposal,
  type Proposal,
  type ProposalDismiss,
  type ProposalOp,
} from './proposal.js';
import { parseLedger, readLedger, upsertLedger, type Ledger, type LedgerOp } from './ledger.js';

const INBOX_PATH_RE = /^\.novel\/[^/]+\.md$/i;
export const DEFAULT_INBOX_PATH = '.novel/inbox.md';
/** 保留文件：账本与声口档案的事实源，收件箱工具族一律不得触碰。 */
const RESERVED_INBOX_NAMES = new Set(['ledger.md', 'style.md']);
const ENTRY_START = '<!-- inbox-entry:start ';
const ENTRY_END = '<!-- inbox-entry:end -->';
/** 定界标记转义：摘句正文可能原样含标记串，入块前插零宽连接符防解析串位，读出块后还原。 */
const MARKER_RAW = '<!-- inbox-entry:';
const MARKER_ESCAPED = '<!-- inbox\u200b-entry:';
const INBOX_HEADER =
  '# 裁决收件箱\n\n> 提案与预警同一收件箱（统一裁决状态机）。裁决纪律：驳回必带理由，有意延后=一等公民（带新预计卷作卷锚重报依据）。\n> 注意：条目之间不要手写批注——重写收件箱时条目间文本会被清除，批注请写在本头部区。\n';

export interface InboxEntry {
  proposal: Proposal;
  /** adopt 落账后的回读验证结果（decide 时写入，随块持久化）。 */
  verify?: { ok: boolean; message: string };
}

function looksLikeLedger(abs: string): boolean {
  try {
    parseLedger(fs.readFileSync(abs, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

function assertInboxPath(workDir: string, relPath: string): string {
  const wd = assertWorkDir(workDir);
  // 先归一化+符号链接落点校验，再对归一化 posix 做白名单判断（fsutil 安全契约；防 manuscript/../ 绕过与 symlink 写穿）
  const { abs, posix } = resolveInsidePosix(wd, relPath);
  if (!INBOX_PATH_RE.test(posix)) {
    throw new Error(`收件箱路径必须是 .novel/ 根目录正下的 .md: ${relPath}`);
  }
  const base = posix.split('/').pop()!.toLowerCase();
  if (RESERVED_INBOX_NAMES.has(base)) {
    throw new Error(`收件箱路径不得占用保留文件（账本/声口档案）: ${posix}`);
  }
  // 目标已存在且能解析为账本 → 拒绝（口径同 write_meta：防收件箱全文重组覆写账本事实源）
  if (fs.existsSync(abs) && looksLikeLedger(abs)) {
    throw new Error(`收件箱路径拒绝：目标内容是账本文件（账本请用 ledger 工具族）: ${posix}`);
  }
  return abs;
}

/** 读收件箱文件状态（CAS 基准+内容）；不存在=空态，其他读错误如实抛出（防以近空内容覆盖真文件）。 */
function readInboxState(abs: string): { exists: boolean; mtimeMs: number; content: string } {
  try {
    const st = fs.statSync(abs);
    return { exists: true, mtimeMs: st.mtimeMs, content: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, mtimeMs: 0, content: '' };
    throw err;
  }
}

function escapeMarkers(md: string): string {
  return md.replaceAll(MARKER_RAW, MARKER_ESCAPED);
}

function unescapeMarkers(md: string): string {
  return md.replaceAll(MARKER_ESCAPED, MARKER_RAW);
}

/** 读取收件箱全部条目（文件不存在=空收件箱；损坏块保留为解析错误项，裁决时可见不静默）。 */
export function inboxList(workDir: string, inboxPath: string = DEFAULT_INBOX_PATH): InboxEntry[] {
  const abs = assertInboxPath(workDir, inboxPath);
  const { content } = readInboxState(abs);
  const out: InboxEntry[] = [];
  const re = /<!-- inbox-entry:start (.*?) -->\r?\n([\s\S]*?)<!-- inbox-entry:end -->/g;
  for (const m of content.matchAll(re)) {
    const header = parseYaml(unescapeMarkers(m[1]!)) as { id?: string } | null;
    const block = unescapeMarkers(m[2]!);
    const verifyMatch = block.match(/^> 回读验证：(✅|❌) (.+)$/m);
    try {
      const proposal = parseProposal(block);
      const entry: InboxEntry = { proposal };
      if (verifyMatch) {
        entry.verify = { ok: verifyMatch[1] === '✅', message: verifyMatch[2]!.trim() };
      }
      out.push(entry);
    } catch (err) {
      out.push({
        proposal: { id: header?.id ?? 'UNKNOWN', origin: 'scan', createdAt: '', ops: [], status: 'pending' },
        verify: { ok: false, message: `提案块解析失败: ${(err as Error).message}` },
      });
    }
  }
  return out;
}

function renderEntry(entry: InboxEntry): string {
  let md = serializeProposal(entry.proposal);
  if (entry.verify) {
    md += `> 回读验证：${entry.verify.ok ? '✅' : '❌'} ${entry.verify.message}\n`;
  }
  return `${ENTRY_START}${entry.proposal.id} -->\n${escapeMarkers(md)}${ENTRY_END}\n`;
}

/** 收件箱文件全文重组（头部说明等人审文字保持原样；条目间手写文本会被清除——头部有警示）。 */
function rewriteInbox(content: string, entries: InboxEntry[]): string {
  const header = content.includes(ENTRY_START) ? content.split(ENTRY_START)[0]! : content || INBOX_HEADER;
  return header + entries.map(renderEntry).join('\n');
}

/** CAS 写入：读时状态与写前不一致即拒绝（防并发互相覆盖）；原子写防写一半损坏。 */
function saveInbox(abs: string, next: string, before: { exists: boolean; mtimeMs: number; content: string }): void {
  const now = readInboxState(abs);
  if (now.exists !== before.exists || now.mtimeMs !== before.mtimeMs || now.content !== before.content) {
    throw new Error('收件箱已被其他进程修改，请刷新后重试');
  }
  atomicWrite(abs, next);
}

/** 追加提案（幂等：pending 中同 (action,targetKey) 去重；「误报」裁决键永久抑制再入）。返回 {added, skipped, outcomes}（outcomes 与入参同序）。 */
export function inboxAppend(
  workDir: string,
  proposals: Proposal[],
  inboxPath: string = DEFAULT_INBOX_PATH,
): { added: string[]; skipped: string[]; outcomes: Array<{ id: string; added: boolean; skippedKeys?: string[] }> } {
  const abs = assertInboxPath(workDir, inboxPath);
  const state = readInboxState(abs); // 不存在=首次建箱
  const entries = inboxList(workDir, inboxPath);
  const keyOf = (o: { action: string; targetKey: string }): string => `${o.action}:${o.targetKey}`;
  const pendingKeys = new Set(entries.filter((e) => e.proposal.status === 'pending').flatMap((e) => e.proposal.ops.map(keyOf)));
  const suppressedKeys = new Set(
    entries
      .filter((e) => e.proposal.status === 'discarded' && e.proposal.resolution?.dismiss?.reason === '误报')
      .flatMap((e) => e.proposal.ops.map(keyOf)),
  );
  const added: string[] = [];
  const skipped: string[] = [];
  const outcomes: Array<{ id: string; added: boolean; skippedKeys?: string[] }> = [];
  for (const p of proposals) {
    // op 级去重（4.2.1 挂账承接）：重叠键剔除、新候选不整提案静默丢；全重叠才整条 skip
    const fresh = p.ops.filter((o) => !pendingKeys.has(keyOf(o)) && !suppressedKeys.has(keyOf(o)));
    const dupKeys = p.ops.filter((o) => pendingKeys.has(keyOf(o)) || suppressedKeys.has(keyOf(o))).map(keyOf);
    if (fresh.length === 0) {
      skipped.push(p.id);
      outcomes.push({ id: p.id, added: false, ...(dupKeys.length > 0 ? { skippedKeys: dupKeys } : {}) });
      continue;
    }
    const kept = fresh.length === p.ops.length ? p : { ...p, ops: fresh };
    entries.push({ proposal: kept });
    for (const o of fresh) pendingKeys.add(keyOf(o));
    added.push(kept.id);
    outcomes.push({ id: kept.id, added: true, ...(dupKeys.length > 0 ? { skippedKeys: dupKeys } : {}) });
  }
  if (added.length > 0) saveInbox(abs, rewriteInbox(state.content, entries), state);
  return { added, skipped, outcomes };
}

export interface DecideResult {
  proposal: Proposal;
  applied: boolean;
  denials: string[];
  verify?: { ok: boolean; message: string };
}

/**
 * 回读验证：ADD/UPDATE 验条目在位，DELETE 验消失（修复过闸，铁律 4）。
 * 逐维对账到真实落点（clock 按 chapters 键、登记表按文本精确匹配）——此前非实体维删除成功反判 ❌、
 * clock/登记表 upsert 恒 ✅ 空转。导出仅供测试（纯函数，与 prefilterChapter 同风格）。
 */
export function verifyTargets(ledger: Ledger, proposal: Proposal): { ok: boolean; message: string } {
  const messages: string[] = [];
  let ok = true;
  const clockKey = (chapters: string[]): string => [...chapters].sort().join('\u0000');
  const present = (o: ProposalOp): boolean => {
    const op = o.op;
    if (op.op === 'promise') return ledger.promises.some((p) => p.id === (op.entry.id ?? op.entry.name) || p.name === o.targetKey);
    if (op.op === 'prop') return ledger.props.some((p) => p.name === (op.entry.name ?? o.targetKey));
    if (op.op === 'knowledge') return ledger.knowledge.some((k) => k.character === (op.entry.character ?? o.targetKey));
    if (op.op === 'clock') return ledger.clock.some((r) => clockKey(r.chapters) === clockKey(op.entry.chapters));
    if (op.op === 'doNotReexplain') return ledger.doNotReexplain.includes(op.fact);
    if (op.op === 'tripwire') return ledger.tripwires.includes(op.item);
    if (op.op === 'protect') return ledger.protect.some((p) => p.item === op.item);
    if (op.op === 'remove') {
      switch (op.dimension) {
        case 'promise':
          return ledger.promises.some((p) => p.id === op.id);
        case 'prop':
          return ledger.props.some((p) => p.name === op.name);
        case 'knowledge':
          return ledger.knowledge.some((k) => k.character === op.character);
        case 'character':
          return (ledger.characters ?? []).some((c) => c.name === op.name);
        case 'clock':
          return ledger.clock.some((r) => clockKey(r.chapters) === clockKey(op.chapters));
        default:
          return op.dimension === 'doNotReexplain'
            ? ledger.doNotReexplain.includes(op.item)
            : op.dimension === 'tripwire'
              ? ledger.tripwires.includes(op.item)
              : ledger.protect.some((p) => p.item === op.item);
      }
    }
    return true; // 未知形状不误判失败（落账本身有 applyOps 校验兜底）
  };
  for (const o of proposal.ops) {
    if (o.action === 'NOOP') continue;
    const isPresent = present(o);
    const expectPresent = o.action !== 'DELETE';
    if (isPresent !== expectPresent) ok = false;
    messages.push(`${o.action}:${o.targetKey} → ${isPresent ? '在位' : '不在'}（期望${expectPresent ? '在位' : '消失'}）`);
  }
  return { ok, message: messages.join('；') || '无实体操作' };
}

/**
 * 语义预检（4.2.1 挂账承接）：UPDATE 目标必须在位、ADD 键必须空闲——不符转人工（提案留 pending 可改判）。
 * 此前 UPDATE 指向不存在键会静默新建、ADD 覆盖已存条目（陈旧提案无提示覆盖作者手改）。
 * clock/登记表无 ADD/UPDATE 冲突面（幂等集合语义），不检。
 */
function targetConflicts(ledger: Ledger, proposal: Proposal): string[] {
  const denials: string[] = [];
  const exists = (o: ProposalOp): boolean => {
    const op = o.op;
    if (op.op === 'promise') return ledger.promises.some((p) => p.id === (op.entry.id ?? op.entry.name));
    if (op.op === 'prop') return ledger.props.some((p) => p.name === op.entry.name);
    if (op.op === 'knowledge') return ledger.knowledge.some((k) => k.character === op.entry.character);
    if (op.op === 'character') return (ledger.characters ?? []).some((c) => c.name === op.entry.name);
    return true; // clock/登记表：不检
  };
  for (const o of proposal.ops) {
    if (o.action === 'NOOP' || (o.op.op !== 'promise' && o.op.op !== 'prop' && o.op.op !== 'knowledge' && o.op.op !== 'character')) continue;
    if (o.action === 'UPDATE' && !exists(o)) denials.push(`语义预检：UPDATE 目标不在位（${o.targetKey}）——确认后请改用 ADD`);
    if (o.action === 'ADD' && exists(o)) denials.push(`语义预检：ADD 键已占用（${o.targetKey}）——确认覆盖请改用 UPDATE`);
  }
  return denials;
}

/** 裁决：采纳（权限面复核→落账→回读验证），块置 adopted 并持久化验证结论；回读不过=保持 pending 可重试（upsert 幂等）。 */
export function inboxAdopt(workDir: string, proposalId: string, inboxPath: string = DEFAULT_INBOX_PATH): DecideResult {
  const abs = assertInboxPath(workDir, inboxPath);
  const state = readInboxState(abs); // 尚未建箱=无提案，findIndex 落「无此提案」
  const entries = inboxList(workDir, inboxPath);
  const idx = entries.findIndex((e) => e.proposal.id === proposalId);
  if (idx < 0) throw new Error(`收件箱无此提案: ${proposalId}`);
  const current = entries[idx]!.proposal;
  if (current.status !== 'pending') throw new Error(`提案已裁决（${current.status}），不可重复裁决: ${proposalId}`);

  const ops: LedgerOp[] = current.ops.filter((o) => o.action !== 'NOOP').map((o) => o.op);
  if (ops.length === 0) {
    const decided = adoptProposal(current);
    const verify = { ok: true, message: '无实体操作（全 NOOP），无落账' };
    entries[idx] = { proposal: decided, verify };
    saveInbox(abs, rewriteInbox(state.content, entries), state);
    return { proposal: decided, applied: false, denials: [], verify };
  }
  // 权限面复核：提案入箱后账本可能已变（protect 新增等）
  const { ledger } = readLedger(workDir);
  const v = validateProposal(current, ledger);
  if (!v.ok) return { proposal: current, applied: false, denials: v.denials };
  const conflicts = targetConflicts(ledger, current);
  if (conflicts.length > 0) return { proposal: current, applied: false, denials: conflicts };

  upsertLedger(workDir, ops);
  const { ledger: after } = readLedger(workDir);
  const verify = verifyTargets(after, current);
  if (!verify.ok) {
    // 修复过闸（铁律 4）：回读不过不置终态——保持 pending（可重试 adopt 或改判驳回），❌ 结论持久化可见
    entries[idx] = { proposal: current, verify };
    saveInbox(abs, rewriteInbox(state.content, entries), state);
    return { proposal: current, applied: true, denials: [], verify };
  }
  const decided = adoptProposal(current);
  entries[idx] = { proposal: decided, verify };
  saveInbox(abs, rewriteInbox(state.content, entries), state);
  return { proposal: decided, applied: true, denials: [], verify };
}

/** 裁决：驳回（必带理由枚举；有意延后带新预计卷=卷锚重报依据）。终态守卫：已裁决不可再裁决。 */
export function inboxDiscard(workDir: string, proposalId: string, dismiss: ProposalDismiss, inboxPath: string = DEFAULT_INBOX_PATH): DecideResult {
  const abs = assertInboxPath(workDir, inboxPath);
  const state = readInboxState(abs);
  const entries = inboxList(workDir, inboxPath);
  const idx = entries.findIndex((e) => e.proposal.id === proposalId);
  if (idx < 0) throw new Error(`收件箱无此提案: ${proposalId}`);
  if (entries[idx]!.proposal.status !== 'pending') {
    throw new Error(`提案已裁决（${entries[idx]!.proposal.status}），不可重复裁决: ${proposalId}`);
  }
  const decided = discardProposal(entries[idx]!.proposal, dismiss);
  entries[idx] = { proposal: decided };
  saveInbox(abs, rewriteInbox(state.content, entries), state);
  return { proposal: decided, applied: false, denials: [] };
}
