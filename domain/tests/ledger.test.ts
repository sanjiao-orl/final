/**
 * ledger.test.ts —— 四维账本：序列化/解析 round-trip、applyOps、确定性诊断、读写、slice、blocker 计数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it('未知 frontmatter 字段 round-trip 原样保留（不解析不校验，仅透传）', () => {
    const content = [
      '---',
      'clock: []',
      'props: []',
      'promises: []',
      'knowledge: []',
      'doNotReexplain: []',
      'protect: []',
      'tripwires: []',
      'customNote: 人工增补字段',
      'futureConfig:',
      '  enabled: true',
      '  threshold: 3',
      '---',
      '',
      '# Reader Ledger',
    ].join('\n');
    const ledger = parseLedger(content);
    expect(ledger.extra).toEqual({ customNote: '人工增补字段', futureConfig: { enabled: true, threshold: 3 } });
    const serialized = serializeLedger(ledger);
    expect(serialized).toContain('customNote: 人工增补字段');
    expect(serialized).toContain('enabled: true');
    // 二次 round-trip 未知字段仍在
    expect(parseLedger(serialized).extra).toEqual({
      customNote: '人工增补字段',
      futureConfig: { enabled: true, threshold: 3 },
    });
  });

  it('未知字段与已知字段冲突时已知字段优先', () => {
    const ledger = emptyLedger();
    ledger.extra = { clock: '篡改值', customNote: 'x' };
    const serialized = serializeLedger(ledger);
    expect(serialized).toContain('clock: []');
    expect(serialized).toContain('customNote: x');
    expect(parseLedger(serialized).clock).toEqual([]);
    expect(parseLedger(serialized).extra).toEqual({ customNote: 'x' });
  });

  it('无 frontmatter / 非法 YAML 抛「损坏」错误', () => {
    expect(() => parseLedger('# 只是标题\n正文')).toThrow(/损坏/);
    expect(() => parseLedger('---\n{ 非法 yaml\n---\n正文')).toThrow(/损坏/);
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

  it('clock 同集合不同顺序的 chapters 视为同一条（顺序无关）', () => {
    const l = applyOps(emptyLedger(), [
      { op: 'clock', entry: { chapters: ['第一章', '第二章'], thread: '主', storyDay: '第1日' } },
      { op: 'clock', entry: { chapters: ['第二章', '第一章'], thread: '主', storyDay: '第2日' } },
    ]);
    expect(l.clock).toHaveLength(1);
    expect(l.clock[0]!.storyDay).toBe('第2日');
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

  it('clock.chapters 含非字符串元素抛守卫错误而非 TypeError', () => {
    expect(() =>
      applyOps(emptyLedger(), [{ op: 'clock', entry: { chapters: ['第一章', 2 as unknown as string] } } as unknown as LedgerOp]),
    ).toThrow(/chapters 必须是字符串数组/);
  });

  it('remove：clock 按 chapters 集合删除（顺序无关）', () => {
    const l = applyOps(emptyLedger(), [
      { op: 'clock', entry: { chapters: ['第一章', '第二章'], thread: '主' } },
      { op: 'clock', entry: { chapters: ['第三章'], thread: '支' } },
    ]);
    const l2 = applyOps(l, [{ op: 'remove', dimension: 'clock', chapters: ['第二章', '第一章'] }]);
    expect(l2.clock).toHaveLength(1);
    expect(l2.clock[0]!.chapters).toEqual(['第三章']);
  });

  it('remove：prop 按 name、promise 按 id、knowledge 按 character 删除', () => {
    const l = applyOps(emptyLedger(), [
      { op: 'prop', entry: { name: '铜钱', custody: [] } },
      { op: 'prop', entry: { name: '木剑', custody: [] } },
      { op: 'promise', entry: { id: 'P1', name: 'a', arc: 'planted', setups: [], payoffs: [] } },
      { op: 'promise', entry: { id: 'P2', name: 'b', arc: 'planted', setups: [], payoffs: [] } },
      { op: 'knowledge', entry: { character: '林渡', knows: [] } },
      { op: 'knowledge', entry: { character: '阿九', knows: [] } },
    ]);
    const l2 = applyOps(l, [
      { op: 'remove', dimension: 'prop', name: '铜钱' },
      { op: 'remove', dimension: 'promise', id: 'P1' },
      { op: 'remove', dimension: 'knowledge', character: '林渡' },
    ]);
    expect(l2.props.map((p) => p.name)).toEqual(['木剑']);
    expect(l2.promises.map((p) => p.id)).toEqual(['P2']);
    expect(l2.knowledge.map((k) => k.character)).toEqual(['阿九']);
  });

  it('remove：三张登记表按文本精确删除', () => {
    const l = applyOps(emptyLedger(), [
      { op: 'doNotReexplain', fact: '铜钱重量异常' },
      { op: 'protect', item: '铜钱高频出现', reason: '主线道具' },
      { op: 'tripwire', item: '铜钱 ≠ 茶钱' },
    ]);
    const l2 = applyOps(l, [
      { op: 'remove', dimension: 'doNotReexplain', item: '铜钱重量异常' },
      { op: 'remove', dimension: 'protect', item: '铜钱高频出现' },
      { op: 'remove', dimension: 'tripwire', item: '铜钱 ≠ 茶钱' },
    ]);
    expect(l2.doNotReexplain).toEqual([]);
    expect(l2.protect).toEqual([]);
    expect(l2.tripwires).toEqual([]);
  });

  it('remove：删不存在目标静默 no-op（幂等，与登记表去重追加风格一致）', () => {
    const l = applyOps(emptyLedger(), [{ op: 'tripwire', item: '保留' }]);
    const l2 = applyOps(l, [
      { op: 'remove', dimension: 'clock', chapters: ['第一章'] },
      { op: 'remove', dimension: 'prop', name: '不存在' },
      { op: 'remove', dimension: 'promise', id: 'P9' },
      { op: 'remove', dimension: 'knowledge', character: '无此人' },
      { op: 'remove', dimension: 'doNotReexplain', item: '无此条' },
      { op: 'remove', dimension: 'protect', item: '无此条' },
      { op: 'remove', dimension: 'tripwire', item: '无此条' },
    ]);
    expect(l2.tripwires).toEqual(['保留']);
    expect(l2.clock).toEqual([]);
    expect(l2.props).toEqual([]);
    expect(l2.promises).toEqual([]);
    expect(l2.knowledge).toEqual([]);
  });

  it('remove 非法入参抛「ledger_upsert 的 ops 不合法」守卫错误', () => {
    expect(() => applyOps(emptyLedger(), [{ op: 'remove' } as unknown as LedgerOp])).toThrow(
      /ledger_upsert 的 ops 不合法: remove 缺少 dimension/,
    );
    expect(() =>
      applyOps(emptyLedger(), [{ op: 'remove', dimension: 'clock', chapters: [] } as unknown as LedgerOp]),
    ).toThrow(/remove clock 需要非空 chapters/);
    expect(() => applyOps(emptyLedger(), [{ op: 'remove', dimension: 'nope', item: 'x' } as unknown as LedgerOp])).toThrow(
      /未知 remove 维度/,
    );
  });

  it('applyOps 校验错误统一带「ledger_upsert 的 ops 不合法」前缀（对齐 tools.ts 守卫风格）', () => {
    expect(() => applyOps(emptyLedger(), [{ op: 'nope' } as unknown as LedgerOp])).toThrow(
      /ledger_upsert 的 ops 不合法: 未知 ledger 操作/,
    );
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

  it('upsert 读改写后未知 frontmatter 字段仍在（读→改→写不丢）', () => {
    const work = makeWorkDir();
    const ledgerPath = '.novel/ledger.md';
    writeTree(work, {
      [ledgerPath]: [
        '---',
        'clock: []',
        'props: []',
        'promises: []',
        'knowledge: []',
        'doNotReexplain: []',
        'protect: []',
        'tripwires: []',
        '人工字段: 保留值',
        '---',
        '',
        '# Reader Ledger',
      ].join('\n'),
    });
    upsertLedger(work, [{ op: 'tripwire', item: '新规则' }], ledgerPath);
    const out = fs.readFileSync(path.join(work, ledgerPath), 'utf8');
    expect(out).toContain('保留值');
    expect(out).toContain('新规则');
    expect(readLedger(work, ledgerPath).ledger.extra).toEqual({ 人工字段: '保留值' });
  });

  it('upsert 读改之间文件被外部改写 → 抛「账本已被其他进程修改」且不覆盖', () => {
    const work = makeWorkDir();
    writeLedger(work, sampleLedger());
    const abs = path.join(work, '.novel/ledger.md');
    const realStat = fs.statSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      calls += 1;
      if (calls === 2) {
        // 模拟外部进程在「读旧账本之后、写新账本之前」改写了文件
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n<!-- external write -->\n', 'utf8');
      }
      return realStat(p);
    }) as typeof fs.statSync);
    try {
      expect(() => upsertLedger(work, [{ op: 'tripwire', item: '新规则' }])).toThrow(/账本已被其他进程修改/);
      const after = fs.readFileSync(abs, 'utf8');
      expect(after).toContain('external write'); // 外部改写内容原样保留
      expect(after).not.toContain('新规则'); // 本次 upsert 未写入
      expect(fs.existsSync(path.join(work, '.novel', 'history'))).toBe(false); // 未走到快照/写
    } finally {
      spy.mockRestore();
    }
  });

  it('损坏账本：readLedger/upsertLedger 抛「损坏」且不覆盖原文件', () => {
    const work = makeWorkDir();
    const corrupt = '---\n{ 非法 yaml\n---\n正文';
    writeTree(work, { '.novel/ledger.md': corrupt });
    expect(() => readLedger(work)).toThrow(/损坏/);
    expect(() => upsertLedger(work, [{ op: 'tripwire', item: 'x' }])).toThrow(/损坏/);
    expect(fs.readFileSync(path.join(work, '.novel/ledger.md'), 'utf8')).toBe(corrupt);
  });

  it('upsert 成功路径在 .novel/history/ 留下旧账本快照', () => {
    const work = makeWorkDir();
    const ledgerPath = '.novel/review.md';
    writeLedger(work, sampleLedger(), ledgerPath);
    upsertLedger(work, [{ op: 'tripwire', item: '新增硬规则' }], ledgerPath);
    const snapDir = path.join(work, '.novel', 'history', '.novel__review');
    const snaps = fs.readdirSync(snapDir).filter((n) => n.endsWith('.md'));
    expect(snaps).toHaveLength(1);
    const oldContent = fs.readFileSync(path.join(snapDir, snaps[0]!), 'utf8');
    expect(oldContent).toContain('铜钱');
    expect(oldContent).not.toContain('新增硬规则');
  });

  it('ledgerPath 覆盖默认位置', () => {
    const work = makeWorkDir();
    writeLedger(work, sampleLedger(), '.novel/review.md');
    expect(readLedger(work).ledger).toEqual(emptyLedger()); // 默认位置为空
    expect(readLedger(work, '.novel/review.md').ledger).toEqual(sampleLedger());
  });

  it('ledgerPath 拒绝 manuscript/ 与 .novel/history/、.novel/trash/ 内的 .md', () => {
    const work = makeWorkDir();
    expect(() => writeLedger(work, sampleLedger(), 'manuscript/卷一/第1章.md')).toThrow(/只允许/);
    expect(() => writeLedger(work, sampleLedger(), '.novel/history/ledger.md')).toThrow(/只允许/);
    expect(() => writeLedger(work, sampleLedger(), '.novel/trash/ledger.md')).toThrow(/只允许/);
    expect(() => readLedger(work, 'manuscript/卷一/第1章.md')).toThrow(/只允许/);
  });

  it('ledgerPath 放行 .novel/ 根下 .md（.novel/ledger.md 与 .novel/review.md）', () => {
    const work = makeWorkDir();
    writeLedger(work, sampleLedger(), '.novel/ledger.md');
    expect(readLedger(work, '.novel/ledger.md').ledger).toEqual(sampleLedger());
    writeLedger(work, sampleLedger(), '.novel/review.md');
    expect(readLedger(work, '.novel/review.md').ledger).toEqual(sampleLedger());
  });

  it('ledgerPath 白名单化：拒绝 AGENTS.md、editorial_notes/、.novel/ 子目录与 history 内 .md', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'AGENTS.md': 'agent 规则',
      'editorial_notes/issues.md': '编辑笔记',
      '.novel/notes/book.md': '私有笔记',
      '.novel/history/x.md': '旧章快照',
    });
    for (const rel of ['AGENTS.md', 'editorial_notes/issues.md', '.novel/notes/book.md', '.novel/history/x.md']) {
      expect(() => readLedger(work, rel), rel).toThrow(/只允许/);
      expect(() => writeLedger(work, sampleLedger(), rel), rel).toThrow(/只允许/);
    }
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

  it('chapterRelPath 为全稿导出/根目录 txt/.novel 内文件 → 拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, { '全稿-20260101.txt': '全稿正文', '.novel/ledger.md': serializeLedger(sampleLedger()) });
    expect(() => ledgerSlice(work, '全稿-20260101.txt')).toThrow(/manuscript/);
    expect(() => ledgerSlice(work, '.novel/ledger.md')).toThrow(/manuscript/);
  });

  it('issueLogPath 为 manuscript/ 内文件 → 拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。' });
    expect(() => ledgerSlice(work, 'manuscript/第1章.md', undefined, 'manuscript/第1章.md')).toThrow(/issueLogPath/);
  });

  it('issueLogPath 白名单化：拒绝 manuscript/ 章正文与 .novel/history/ 旧章快照', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。',
      'manuscript/章.md': '---\ntitle: 章\n---\n其他章正文。',
      '.novel/history/旧章.md': '旧章正文尾段 40 行',
    });
    expect(() => ledgerSlice(work, 'manuscript/第1章.md', undefined, 'manuscript/章.md')).toThrow(/issueLogPath/);
    expect(() => ledgerSlice(work, 'manuscript/第1章.md', undefined, '.novel/history/旧章.md')).toThrow(/issueLogPath/);
  });

  it('issueLogPath 放行 editorial_notes/issues.md（只注入最后约 40 行）', () => {
    const work = makeWorkDir();
    const issueLines = Array.from({ length: 45 }, (_, i) => `CR-${String(i + 1).padStart(3, '0')} | ch1:1 | MINOR | CONT | "x" | why | fix | LINE`);
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。',
      'editorial_notes/issues.md': issueLines.join('\n'),
    });
    const { slice } = ledgerSlice(work, 'manuscript/第1章.md', undefined, 'editorial_notes/issues.md');
    const injected = slice.split(/\r?\n/).filter((l) => l.startsWith('CR-'));
    expect(injected).toHaveLength(40); // 只注入最后 40 行
    expect(injected[0]).toContain('CR-006'); // 45 条日志 slice(-40) 从第 6 条开始
  });
});

describe('countBlockers', () => {
  it('按 CR 行第 3 个字段（severity 列）计数', () => {
    const log = [
      'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE',
      'CR-002 | ch1:2 | MINOR | REPEAT | "y" | why | fix | LINE',
      'CR-003 | ch2:1 | BLOCKER | CANON | "z" | why | fix | SCENE',
    ].join('\n');
    expect(countBlockers(log)).toEqual({ blockers: 2, hasBlockers: true });
  });

  it('quote/why 字段含 "| BLOCKER |" 片段不多计（只认 severity 列）', () => {
    const log = [
      'CR-001 | ch1:1 | MINOR | REPEAT | "他说 | BLOCKER | 是误报" | why | fix | LINE',
      'CR-002 | ch1:2 | MINOR | REPEAT | "x" | 引用 | BLOCKER | 片段 | fix | LINE',
      'CR-003 | ch1:3 | BLOCKER | CONT | "x" | why | fix | LINE',
    ].join('\n');
    expect(countBlockers(log)).toEqual({ blockers: 1, hasBlockers: true });
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

  it('diagnosticsForWork 的 issueLogPath 复用同一白名单：白名单外一律抛错', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。',
      '.novel/history/旧章.md': '旧章快照',
    });
    expect(() => diagnosticsForWork(work, undefined, 'manuscript/章.md')).toThrow(/issueLogPath/);
    expect(() => diagnosticsForWork(work, undefined, '.novel/history/旧章.md')).toThrow(/issueLogPath/);
    expect(() => diagnosticsForWork(work, undefined, 'AGENTS.md')).toThrow(/issueLogPath/);
    // 白名单内但文件缺失 → 仍计 0（与「缺失计 0」口径一致）
    const res = diagnosticsForWork(work, undefined, 'editorial_notes/issues.md');
    expect(res.blockerCount).toBe(0);
  });
});
