/**
 * ledger.test.ts —— 四维账本：序列化/解析 round-trip、applyOps、确定性诊断、读写、slice、blocker 计数。
 */
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  countBlockers,
  diagnoseChapterHeadJump,
  diagnoseSeasonConflict,
  diagnosticsForWork,
  emptyLedger,
  ledgerDiagnostics,
  ledgerSlice,
  parseLedger,
  readLedger,
  renderLedgerMarkdown,
  serializeLedger,
  upsertLedger,
  writeLedger,
  type Ledger,
  type LedgerOp,
} from '../src/ledger.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 一个字段齐全的样例账本。 */
function sampleLedger(): Ledger {
  return {
    clock: [
      {
        chapters: ['第一章·少年'],
        thread: '主',
        storyDay: '第1日',
        season: '未锚定',
        notes: '晨寒 vs 晌午日蒸，双温度并存',
      },
    ],
    props: [
      {
        name: '铜钱',
        type: '信物',
        holder: '林渡',
        status: '边缘磨亮、方孔红绳',
        custody: [
          { chapter: '第一章·少年', line: 12, holder: '林渡', note: '临行接手' },
          { chapter: '第一章·少年', line: 30, holder: '林渡', note: '茶棚' },
        ],
        tripwire: '不得出现第二枚',
      },
    ],
    promises: [
      {
        id: 'P1',
        name: '铜钱来历',
        arc: 'planted',
        heat: 'HOT',
        setups: [{ chapter: '第一章·少年', line: 12, quote: '分量不对' }],
        payoffs: [],
        due: 3,
        note: '师父半句话未说完',
      },
    ],
    knowledge: [
      {
        character: '林渡',
        knows: ['铜钱沉近一倍'],
        doesNotKnow: ['铜钱来历'],
        visibility: 'public',
      },
    ],
    doNotReexplain: ['铜钱重量异常'],
    protect: [{ item: '铜钱高频出现', reason: '主线道具逐拍推进' }],
    tripwires: ['铜钱 ≠ 茶钱/店钱'],
  };
}

describe('序列化 / 解析 round-trip', () => {
  it('空账本 round-trip', () => {
    const content = serializeLedger(emptyLedger());
    expect(parseLedger(content)).toEqual(emptyLedger());
  });

  it('全字段账本 round-trip 不丢字段', () => {
    const ledger = sampleLedger();
    const content = serializeLedger(ledger);
    expect(parseLedger(content)).toEqual(ledger);
  });

  it('无 frontmatter / 非法 YAML 返回空账本', () => {
    expect(parseLedger('# 只是标题\n正文')).toEqual(emptyLedger());
    expect(parseLedger('---\n{ 非法 yaml\n---\n正文')).toEqual(emptyLedger());
  });

  it('渲染 Markdown 含四维标题', () => {
    const md = renderLedgerMarkdown(sampleLedger());
    expect(md).toContain('## Position / Clock table');
    expect(md).toContain('## Promise register');
    expect(md).toContain('## Prop custody');
    expect(md).toContain('## Character knowledge-map');
  });
});

describe('applyOps', () => {
  it('clock 按 chapters 键 upsert', () => {
    const op: LedgerOp = { op: 'clock', entry: { chapters: ['第一章'], thread: '主', storyDay: '第1日' } };
    const l1 = applyOps(emptyLedger(), [op]);
    expect(l1.clock).toHaveLength(1);
    const l2 = applyOps(l1, [{ op: 'clock', entry: { chapters: ['第一章'], thread: '主', storyDay: '第2日' } }]);
    expect(l2.clock).toHaveLength(1);
    expect(l2.clock[0]!.storyDay).toBe('第2日');
  });

  it('prop 按 name、promise 按 id、knowledge 按 character 键 upsert', () => {
    const ops: LedgerOp[] = [
      { op: 'prop', entry: { name: '铜钱', custody: [] } },
      { op: 'promise', entry: { id: 'P1', name: '铜钱来历', arc: 'planted', setups: [], payoffs: [] } },
      { op: 'knowledge', entry: { character: '林渡', knows: ['a'] } },
    ];
    const l = applyOps(emptyLedger(), ops);
    expect(l.props).toHaveLength(1);
    expect(l.promises).toHaveLength(1);
    expect(l.knowledge).toHaveLength(1);
    const l2 = applyOps(l, [
      { op: 'prop', entry: { name: '铜钱', custody: [{ chapter: '第一章', holder: '林渡' }] } },
      { op: 'promise', entry: { id: 'P1', name: '铜钱来历', arc: 'resolved', setups: [], payoffs: [{ chapter: '第二章' }] } },
      { op: 'knowledge', entry: { character: '林渡', knows: ['a', 'b'] } },
    ]);
    expect(l2.props).toHaveLength(1);
    expect(l2.props[0]!.custody).toHaveLength(1);
    expect(l2.promises[0]!.arc).toBe('resolved');
    expect(l2.knowledge[0]!.knows).toEqual(['a', 'b']);
  });

  it('登记表去重追加', () => {
    const l = applyOps(emptyLedger(), [
      { op: 'doNotReexplain', fact: 'x' },
      { op: 'doNotReexplain', fact: 'x' },
      { op: 'protect', item: 'y', reason: 'r' },
      { op: 'protect', item: 'y' },
      { op: 'tripwire', item: 'z' },
      { op: 'tripwire', item: 'z' },
    ]);
    expect(l.doNotReexplain).toEqual(['x']);
    expect(l.protect).toEqual([{ item: 'y', reason: 'r' }]);
    expect(l.tripwires).toEqual(['z']);
  });

  it('未知 op / 非法 entry 抛错', () => {
    expect(() => applyOps(emptyLedger(), [{ op: 'nope' } as unknown as LedgerOp])).toThrow(/未知 ledger 操作/);
    expect(() => applyOps(emptyLedger(), [{ op: 'clock', entry: { chapters: [] } } as unknown as LedgerOp])).toThrow(/chapters/);
    expect(() => applyOps(emptyLedger(), [{ op: 'promise', entry: { id: 'P1', name: 'x', arc: 'bad', setups: [], payoffs: [] } } as unknown as LedgerOp])).toThrow(/非法 arc/);
  });
});

describe('账本级确定性诊断', () => {
  it('悬空伏笔：planted + setups>0 + payoffs=0', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [{ id: 'P1', name: 'x', arc: 'planted', heat: 'HOT', setups: [{ chapter: 'ch1' }], payoffs: [] }],
    };
    const f = ledgerDiagnostics(ledger);
    expect(f.some((x) => x.code === 'dangling-promise' && x.severity === 'MAJOR')).toBe(true);
  });

  it('已回收伏笔不报悬空', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [{ id: 'P1', name: 'x', arc: 'resolved', setups: [{ chapter: 'ch1' }], payoffs: [{ chapter: 'ch2' }] }],
    };
    expect(ledgerDiagnostics(ledger)).toEqual([]);
  });

  it('逾期伏笔：埋设后过 ≥due 章未回收', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [{ id: 'P1', name: 'x', arc: 'planted', setups: [{ chapter: 'ch1' }], payoffs: [], due: 2 }],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
      { relPath: 'ch3', title: '三' },
    ];
    const f = ledgerDiagnostics(ledger, order);
    expect(f.some((x) => x.code === 'overdue-promise')).toBe(true);
  });

  it('道具双位冲突：同一章两个不同持有者', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      props: [
        {
          name: '铜钱',
          custody: [
            { chapter: 'ch1', holder: '甲' },
            { chapter: 'ch1', holder: '乙' },
          ],
        },
      ],
    };
    const f = ledgerDiagnostics(ledger);
    expect(f.some((x) => x.code === 'custody-conflict' && x.severity === 'MAJOR')).toBe(true);
  });
});

describe('章正文确定性检查', () => {
  it('章首相对偏移（三日后）报跳变', () => {
    expect(diagnoseChapterHeadJump('三日后，林渡下了山。')).toEqual({ hit: true, phrase: '三日后' });
  });

  it('章首相对偏移（三日前，独立「前」结尾）报跳变', () => {
    expect(diagnoseChapterHeadJump('三日前，他还在山上。')).toEqual({ hit: true, phrase: '三日前' });
  });

  it('承接日（次日/当晚/当天）不报跳变', () => {
    expect(diagnoseChapterHeadJump('次日清晨，他醒来。').hit).toBe(false);
    expect(diagnoseChapterHeadJump('当晚，邻房争执。').hit).toBe(false);
  });

  it('普通正文不报跳变', () => {
    expect(diagnoseChapterHeadJump('清晨雾气沉沉压在山上。').hit).toBe(false);
  });

  it('季节冲突：初春 + 盛夏', () => {
    expect(diagnoseSeasonConflict('初春的风。盛夏的日。')).toEqual({ seasons: ['春', '夏'], conflict: true });
  });

  it('单一季节不冲突', () => {
    expect(diagnoseSeasonConflict('初春的风。').conflict).toBe(false);
  });
});

describe('读写（文件系统）', () => {
  it('write 后 read round-trip', () => {
    const work = makeWorkDir();
    writeLedger(work, sampleLedger());
    const { ledger } = readLedger(work);
    expect(ledger).toEqual(sampleLedger());
  });

  it('文件不存在返回空账本', () => {
    const { ledger } = readLedger(makeWorkDir());
    expect(ledger).toEqual(emptyLedger());
  });

  it('upsert 应用到文件并持久化', () => {
    const work = makeWorkDir();
    upsertLedger(work, [{ op: 'tripwire', item: '铜钱≠茶钱' }]);
    const { ledger } = readLedger(work);
    expect(ledger.tripwires).toEqual(['铜钱≠茶钱']);
  });

  it('ledgerPath 覆盖默认位置', () => {
    const work = makeWorkDir();
    writeLedger(work, sampleLedger(), 'editorial_notes/reader_ledger.md');
    expect(readLedger(work).ledger).toEqual(emptyLedger()); // 默认位置为空
    expect(readLedger(work, 'editorial_notes/reader_ledger.md').ledger).toEqual(sampleLedger());
  });
});

describe('ledgerSlice（审阅输入组装，禁止全量注入）', () => {
  it('只注入当前章正文，不含其他章全文', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第1章.md': '---\ntitle: 第1章\n---\n第一章正文独特标记AAA。',
      'manuscript/卷一/第2章.md': '---\ntitle: 第2章\n---\n第二章正文独特标记BBB。',
      'manuscript/卷一/第3章.md': '---\ntitle: 第3章\n---\n第三章正文独特标记CCC。',
    });
    writeLedger(work, sampleLedger());
    const { slice, injectedChapters } = ledgerSlice(work, 'manuscript/卷一/第1章.md');
    expect(slice).toContain('第一章正文独特标记AAA');
    expect(slice).not.toContain('第二章正文独特标记BBB');
    expect(slice).not.toContain('第三章正文独特标记CCC');
    expect(injectedChapters).toEqual(['manuscript/卷一/第1章.md']);
  });

  it('含账本渲染与契约', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。' });
    writeLedger(work, sampleLedger());
    const { slice } = ledgerSlice(work, 'manuscript/第1章.md');
    expect(slice).toContain('读者契约');
    expect(slice).toContain('## Position / Clock table');
  });

  it('章节不存在抛错', () => {
    const work = makeWorkDir();
    expect(() => ledgerSlice(work, 'manuscript/不存在.md')).toThrow(/不存在/);
  });
});

describe('countBlockers', () => {
  it('按 | BLOCKER | 计数', () => {
    const log = [
      'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE',
      'CR-002 | ch1:2 | MINOR | REPEAT | "y" | why | fix | LINE',
      'CR-003 | ch2:1 | BLOCKER | CANON | "z" | why | fix | SCENE',
    ].join('\n');
    expect(countBlockers(log)).toEqual({ blockers: 2, hasBlockers: true });
  });

  it('无 BLOCKER', () => {
    expect(countBlockers('CR-001 | ch1:1 | MINOR | REPEAT | "x" | why | fix | LINE')).toEqual({ blockers: 0, hasBlockers: false });
  });
});

describe('diagnosticsForWork（端到端）', () => {
  it('对 workdir 跑章级季节冲突 + 账本级悬空', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第1章.md': '---\ntitle: 第1章\n---\n初春的风。盛夏的日。',
    });
    upsertLedger(work, [
      { op: 'promise', entry: { id: 'P1', name: 'x', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [] } },
    ]);
    const res = diagnosticsForWork(work);
    expect(res.findings.some((f) => f.code === 'season-conflict')).toBe(true);
    expect(res.findings.some((f) => f.code === 'dangling-promise')).toBe(true);
    expect(res.hasBlockers).toBe(false);
    expect(res.blockerCount).toBe(0);
  });

  it('问题日志的 BLOCKER 计数折叠进 hasBlockers', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。',
      'editorial_notes/issues.md': [
        'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE',
        'CR-002 | ch1:2 | MINOR | REPEAT | "y" | why | fix | LINE',
      ].join('\n'),
    });
    const res = diagnosticsForWork(work, undefined, 'editorial_notes/issues.md');
    expect(res.blockerCount).toBe(1);
    expect(res.hasBlockers).toBe(true);
  });

  it('问题日志缺失时 blockerCount=0', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。' });
    const res = diagnosticsForWork(work, undefined, 'editorial_notes/不存在.md');
    expect(res.blockerCount).toBe(0);
    expect(res.hasBlockers).toBe(false);
  });
});
