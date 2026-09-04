/**
 * inbox.ts —— 统一裁决收件箱（reference/05 §裁决回路；4.2 薄切片批，承诺·伏笔窄域先行）。
 *
 * 收件箱 = md 文件（人审内容留 md 纪律），路径白名单 `.novel/` 根下 .md（复用 ledger 白名单口径）。
 * 每条提案以 HTML 注释定界块存储（内嵌 serializeProposal 完整 md，round-trip 由 parseProposal 保证）；
 * 预筛→扫描→提案 的产物入箱，裁决改写块状态：
 * - adopt：权限面复核（写闸）→ upsertLedger 落账 → 回读验证目标条目在位（修复过闸，铁律 4；DELETE 验消失）；
 * - discard：必带理由枚举，「有意延后」一等公民（新预计卷=卷锚重报依据）。
 * 追加幂等：pending 态中同 (action,targetKey) 去重，重跑扫描不产生重复项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertWorkDir, toPosix } from './fsutil.js';
import {
  adoptProposal,
  discardProposal,
  parseProposal,
  serializeProposal,
  validateProposal,
  type Proposal,
  type ProposalDismiss,
} from './proposal.js';
import { readLedger, upsertLedger, type Ledger, type LedgerOp } from './ledger.js';

const INBOX_PATH_RE = /^\.novel\/[^/]+\.md$/i;
export const DEFAULT_INBOX_PATH = '.novel/inbox.md';
const ENTRY_START = '<!-- inbox-entry:start ';
const ENTRY_END = '<!-- inbox-entry:end -->';
const INBOX_HEADER = '# 裁决收件箱\n\n> 提案与预警同一收件箱（统一裁决状态机）。裁决纪律：驳回必带理由，有意延后=一等公民（带新预计卷作卷锚重报依据）。\n';

export interface InboxEntry {
  proposal: Proposal;
  /** adopt 落账后的回读验证结果（decide 时写入，随块持久化）。 */
  verify?: { ok: boolean; message: string };
}

function assertInboxPath(workDir: string, relPath: string): string {
  const wd = assertWorkDir(workDir);
  const posix = toPosix(relPath);
  if (!INBOX_PATH_RE.test(posix)) {
    throw new Error(`收件箱路径必须是 .novel/ 根目录正下的 .md: ${relPath}`);
  }
  return path.join(wd, posix);
}

/** 读取收件箱全部条目（文件不存在=空收件箱；损坏块保留为解析错误项，裁决时可见不静默）。 */
export function inboxList(workDir: string, inboxPath: string = DEFAULT_INBOX_PATH): InboxEntry[] {
  const abs = assertInboxPath(workDir, inboxPath);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const out: InboxEntry[] = [];
  const re = /<!-- inbox-entry:start (.*?) -->\r?\n([\s\S]*?)<!-- inbox-entry:end -->/g;
  for (const m of content.matchAll(re)) {
    const header = parseYaml(m[1]!) as { id?: string } | null;
    const block = m[2]!;
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
  return `${ENTRY_START}${entry.proposal.id} -->\n${md}${ENTRY_END}\n`;
}

/** 收件箱文件全文重组（头部说明等人审文字保持原样）。 */
function rewriteInbox(content: string, entries: InboxEntry[]): string {
  const header = content.includes(ENTRY_START) ? content.split(ENTRY_START)[0]! : content || INBOX_HEADER;
  return header + entries.map(renderEntry).join('\n');
}

function saveInbox(abs: string, next: string): void {
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, next, 'utf8');
}

/** 追加提案（幂等：pending 中同 (action,targetKey) 去重）。返回 {added, skipped}。 */
export function inboxAppend(workDir: string, proposals: Proposal[], inboxPath: string = DEFAULT_INBOX_PATH): { added: string[]; skipped: string[] } {
  const abs = assertInboxPath(workDir, inboxPath);
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    content = ''; // 首次建箱
  }
  const entries = inboxList(workDir, inboxPath);
  const pendingKeys = new Set(
    entries
      .filter((e) => e.proposal.status === 'pending' && !e.verify)
      .flatMap((e) => e.proposal.ops.map((o) => `${o.action}:${o.targetKey}`)),
  );
  const added: string[] = [];
  const skipped: string[] = [];
  for (const p of proposals) {
    if (p.ops.some((o) => pendingKeys.has(`${o.action}:${o.targetKey}`))) {
      skipped.push(p.id);
      continue;
    }
    entries.push({ proposal: p });
    for (const o of p.ops) pendingKeys.add(`${o.action}:${o.targetKey}`);
    added.push(p.id);
  }
  if (added.length > 0) saveInbox(abs, rewriteInbox(content, entries));
  return { added, skipped };
}

export interface DecideResult {
  proposal: Proposal;
  applied: boolean;
  denials: string[];
  verify?: { ok: boolean; message: string };
}

/** 回读验证：ADD/UPDATE 验条目在位，DELETE 验消失（修复过闸，铁律 4）。 */
function verifyTargets(ledger: Ledger, proposal: Proposal): { ok: boolean; message: string } {
  const messages: string[] = [];
  let ok = true;
  for (const o of proposal.ops) {
    if (o.action === 'NOOP') continue;
    let present: boolean;
    if (o.op.op === 'promise') present = ledger.promises.some((p) => p.id === targetId(o) || p.name === o.targetKey);
    else if (o.op.op === 'remove') {
      const dim: 'clock' | 'prop' | 'promise' | 'knowledge' | 'doNotReexplain' | 'protect' | 'tripwire' = o.op.dimension;
      if (dim === 'promise') present = ledger.promises.some((p) => p.id === o.targetKey);
      else if (dim === 'prop') present = ledger.props.some((p) => p.name === o.targetKey);
      else if (dim === 'knowledge') present = ledger.knowledge.some((k) => k.character === o.targetKey);
      else present = !ledger.doNotReexplain.includes(o.targetKey) && !ledger.tripwires.includes(o.targetKey) && !ledger.protect.some((p) => p.item === o.targetKey);
    } else if (o.op.op === 'prop') present = ledger.props.some((p) => p.name === o.targetKey);
    else if (o.op.op === 'knowledge') present = ledger.knowledge.some((k) => k.character === o.targetKey);
    else present = true;
    const expectPresent = o.action !== 'DELETE';
    const good = present === expectPresent;
    if (!good) ok = false;
    messages.push(`${o.action}:${o.targetKey} → ${present ? '在位' : '不在'}（期望${expectPresent ? '在位' : '消失'}）`);
  }
  return { ok, message: messages.join('；') || '无实体操作' };
}

function targetId(o: { op: LedgerOp }): string {
  return o.op.op === 'promise' ? (o.op.entry.id ?? o.op.entry.name) : '';
}

/** 裁决：采纳（权限面复核→落账→回读验证），收件箱块改写为 adopted 并持久化验证结论。 */
export function inboxAdopt(workDir: string, proposalId: string, inboxPath: string = DEFAULT_INBOX_PATH): DecideResult {
  const abs = assertInboxPath(workDir, inboxPath);
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    content = ''; // 收件箱尚未建=无提案，findIndex 落「无此提案」
  }
  const entries = inboxList(workDir, inboxPath);
  const idx = entries.findIndex((e) => e.proposal.id === proposalId);
  if (idx < 0) throw new Error(`收件箱无此提案: ${proposalId}`);
  const current = entries[idx]!.proposal;

  const ops: LedgerOp[] = current.ops.filter((o) => o.action !== 'NOOP').map((o) => o.op);
  if (ops.length === 0) {
    const decided = adoptProposal(current);
    const entry: InboxEntry = { proposal: decided, verify: { ok: true, message: '无实体操作（全 NOOP），无落账' } };
    entries[idx] = entry;
    saveInbox(abs, rewriteInbox(content, entries));
    return { proposal: decided, applied: false, denials: ['无实体操作（全 NOOP）'], ...(entry.verify ? { verify: entry.verify } : {}) };
  }
  // 权限面复核：提案入箱后账本可能已变（protect 新增等）
  const { ledger } = readLedger(workDir);
  const v = validateProposal(current, ledger);
  if (!v.ok) return { proposal: current, applied: false, denials: v.denials };

  upsertLedger(workDir, ops);
  const { ledger: after } = readLedger(workDir);
  const verify = verifyTargets(after, current);
  const decided = adoptProposal(current);
  const entry: InboxEntry = { proposal: decided, verify };
  entries[idx] = entry;
  saveInbox(abs, rewriteInbox(content, entries));
  return { proposal: decided, applied: true, denials: [], verify };
}

/** 裁决：驳回（必带理由枚举；有意延后带新预计卷=卷锚重报依据）。 */
export function inboxDiscard(workDir: string, proposalId: string, dismiss: ProposalDismiss, inboxPath: string = DEFAULT_INBOX_PATH): DecideResult {
  const abs = assertInboxPath(workDir, inboxPath);
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    content = '';
  }
  const entries = inboxList(workDir, inboxPath);
  const idx = entries.findIndex((e) => e.proposal.id === proposalId);
  if (idx < 0) throw new Error(`收件箱无此提案: ${proposalId}`);
  const decided = discardProposal(entries[idx]!.proposal, dismiss);
  entries[idx] = { proposal: decided };
  saveInbox(abs, rewriteInbox(content, entries));
  return { proposal: decided, applied: false, denials: [] };
}
