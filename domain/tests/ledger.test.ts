/**
 * ledger.test.ts —— 四维账本：序列化/解析 round-trip、applyOps、确定性诊断、读写、slice、blocker 计数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyOps,
  chapterOrderForWork,
  countBlockers,
  diagnoseChapterHeadJump,
  diagnoseSeasonConflict,
  diagnosticsForWork,
  emptyLedger,
  filterLedgerForChapter,
  ledgerChapterSlice,
  ledgerDiagnostics,
  ledgerSlice,
  parseLedger,
  readLedger,
  renderLedgerMarkdown,
  serializeLedger,
  upsertLedger,
  writeLedger,
  writeMeta,
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
        knows: [{ fact: '铜钱沉近一倍' }],
        doesNotKnow: [{ fact: '铜钱来历' }],
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

  it('旧格式 knows/doesNotKnow 纯字符串数组 → parse 容错升级为 KnowledgeFact', () => {
    const content = [
      '---',
      'clock: []',
      'props: []',
      'promises: []',
      'knowledge:',
      '  - character: 林渡',
      '    knows:',
      '      - 铜钱沉近一倍',
      '      - 师父半句话未说完',
      '    doesNotKnow:',
      '      - 铜钱来历',
      'doNotReexplain: []',
      'protect: []',
      'tripwires: []',
      '---',
      '',
      '# Reader Ledger',
    ].join('\n');
    const ledger = parseLedger(content);
    expect(ledger.knowledge[0]!.knows).toEqual([{ fact: '铜钱沉近一倍' }, { fact: '师父半句话未说完' }]);
    expect(ledger.knowledge[0]!.doesNotKnow).toEqual([{ fact: '铜钱来历' }]);
  });

  it('normalize 容错：对象 fact 非空字符串才收，空 fact/非对象项丢弃（读路径不抛错）', () => {
    const content = [
      '---',
      'clock: []',
      'props: []',
      'promises: []',
      'knowledge:',
      '  - character: 林渡',
      '    knows:',
      '      - fact: 有效事实',
      '        since: manuscript/卷一/第1章.md',
      '        refs:',
      '          - F-001',
      '      - fact: ""',
      '      - 纯字符串',
      '      - 42',
      'doNotReexplain: []',
      'protect: []',
      'tripwires: []',
      '---',
      '',
      '# Reader Ledger',
    ].join('\n');
    const ledger = parseLedger(content);
    expect(ledger.knowledge[0]!.knows).toEqual([
      { fact: '有效事实', since: 'manuscript/卷一/第1章.md', refs: ['F-001'] },
      { fact: '纯字符串' },
    ]);
  });

  it('只有 fact 的 knowledge 项 serialize 写回纯字符串（旧账本 round-trip 格式不变，文本级断言）', () => {
    const ledger = emptyLedger();
    ledger.knowledge = [
      {
        character: '林渡',
        knows: [{ fact: '铜钱沉近一倍' }],
        doesNotKnow: [{ fact: '铜钱来历' }],
        visibility: 'secret',
        knownBy: ['作者'],
      },
    ];
    const content = serializeLedger(ledger);
    // YAML 里 knows 项是纯字符串（`- 铜钱沉近一倍`）不是 `- fact: ...` 对象
    expect(content).toContain('- 铜钱沉近一倍');
    expect(content).not.toContain('- fact: 铜钱沉近一倍');
    // round-trip 结构不变（parse 再升级回 KnowledgeFact）
    expect(parseLedger(content).knowledge[0]!.knows).toEqual([{ fact: '铜钱沉近一倍' }]);
  });

  it('带 since/refs 的 knowledge 项 serialize 写对象（文本级断言）', () => {
    const ledger = emptyLedger();
    ledger.knowledge = [
      { character: '林渡', knows: [{ fact: '闻铃知鬼', since: 'manuscript/卷一/第1章.md', refs: ['F-001'] }] },
    ];
    const content = serializeLedger(ledger);
    expect(content).toContain('since: manuscript/卷一/第1章.md');
    expect(content).toContain('F-001');
    expect(parseLedger(content).knowledge[0]!.knows).toEqual([
      { fact: '闻铃知鬼', since: 'manuscript/卷一/第1章.md', refs: ['F-001'] },
    ]);
  });

  it('promise 新字段 expectedVolume/links 与 knowledge 的 since/refs 往返不丢', () => {
    const ledger = emptyLedger();
    ledger.promises = [
      {
        id: 'P1',
        name: '青铜铃',
        arc: 'planted',
        heat: 'HOT',
        setups: [{ chapter: 'manuscript/卷一/第1章.md', line: 10 }],
        payoffs: [],
        expectedVolume: '卷二',
        links: { props: ['铜钱', '木剑'], characters: ['林渡'] },
      },
    ];
    ledger.knowledge = [
      { character: '林渡', knows: [{ fact: '闻铃知鬼', since: 'manuscript/卷一/第1章.md', refs: ['P1'] }] },
    ];
    const content = serializeLedger(ledger);
    const back = parseLedger(content);
    expect(back.promises[0]!.expectedVolume).toBe('卷二');
    expect(back.promises[0]!.links).toEqual({ props: ['铜钱', '木剑'], characters: ['林渡'] });
    expect(back.knowledge[0]!.knows).toEqual([
      { fact: '闻铃知鬼', since: 'manuscript/卷一/第1章.md', refs: ['P1'] },
    ]);
    // 二次序列化仍保持对象（有 since/refs 不降级为纯字符串）
    expect(serializeLedger(back)).toContain('since: manuscript/卷一/第1章.md');
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

describe('渲染视图（批三-2 结构深化）', () => {
  it('伏笔分层聚合：未回收按卷分组 + HOT 前置，resolved/failed 沉底；悬空/links 内联', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [
        { id: 'P1', name: '甲', arc: 'planted', heat: 'WARM', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [], links: { props: ['铜钱'], characters: ['林渡', '阿九'] } },
        { id: 'P2', name: '乙', arc: 'planted', heat: 'HOT', setups: [{ chapter: 'manuscript/卷一/第2章.md' }], payoffs: [] },
        { id: 'P3', name: '丙', arc: 'resolved', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [{ chapter: 'manuscript/卷一/第3章.md' }] },
        { id: 'P4', name: '丁', arc: 'failed', setups: [{ chapter: 'manuscript/卷一/第2章.md' }], payoffs: [] },
      ],
    };
    const md = renderLedgerMarkdown(ledger);
    expect(md).toContain('### 卷一 · 未回收');
    expect(md).toContain('### 已回收 / 断线');
    // HOT 在 WARM 前（未回收组内）
    const openBlock = md.slice(md.indexOf('### 卷一 · 未回收'), md.indexOf('### 已回收 / 断线'));
    expect(openBlock.indexOf('**P2**')).toBeLessThan(openBlock.indexOf('**P1**'));
    // 悬空 + links 内联
    expect(md).toContain('〔悬空〕');
    expect(md).toContain('（道具: 铜钱 · 角色: 林渡、阿九）');
    // resolved/failed 沉底到「已回收 / 断线」小节
    const closedBlock = md.slice(md.indexOf('### 已回收 / 断线'));
    expect(closedBlock).toContain('**P3**');
    expect(closedBlock).toContain('**P4**');
  });

  it('未分卷伏笔归「未分卷 · 未回收」', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [
        { id: 'P1', name: '甲', arc: 'planted', setups: [{ chapter: 'manuscript/第1章.md' }], payoffs: [] },
      ],
    };
    const md = renderLedgerMarkdown(ledger);
    expect(md).toContain('### 未分卷 · 未回收');
  });

  it('逾期/预计卷已过标记需 chapterOrder；无 chapterOrder 时降级不报错', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [
        {
          id: 'P1', name: '甲', arc: 'planted', heat: 'HOT', due: 1,
          setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [],
          expectedVolume: '卷二',
        },
      ],
    };
    const order = [
      { relPath: 'manuscript/卷一/第1章.md', title: '一' },
      { relPath: 'manuscript/卷一/第2章.md', title: '二' },
      { relPath: 'manuscript/卷一/第3章.md', title: '三' },
    ];
    const md = renderLedgerMarkdown(ledger, { chapterOrder: order });
    // 末章在卷一 ≠ 预计卷卷二 → 已过标记；已过 ≥1 章未回收 → 逾期标记
    expect(md).toContain('〔预计回收卷 卷二 已过〕');
    expect(md).toContain('〔逾期·已过');
    // 无 chapterOrder 降级：不报错、无逾期/预计卷标记（其余照常，悬空仍在）
    const plain = renderLedgerMarkdown(ledger);
    expect(plain).not.toContain('〔逾期');
    expect(plain).not.toContain('〔预计回收卷');
    expect(plain).toContain('〔悬空〕');
  });

  it('知情时间轴：since 按章序排（无 since 排最后）+（自 章）后缀 + 伏笔回指', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      knowledge: [
        {
          character: '林渡',
          knows: [
            { fact: '闻铃知鬼', since: 'manuscript/卷一/第2章.md', refs: ['P1'] },
            { fact: '先闻灯再闻铃', since: 'manuscript/卷一/第1章.md' },
            { fact: '无锚事实' },
          ],
        },
      ],
    };
    const order = [
      { relPath: 'manuscript/卷一/第1章.md', title: '第一章' },
      { relPath: 'manuscript/卷一/第2章.md', title: '第二章' },
    ];
    const md = renderLedgerMarkdown(ledger, { chapterOrder: order });
    expect(md).toContain('（自 第一章）');
    expect(md).toContain('（自 第二章）');
    expect(md).toContain('（伏笔: P1）');
    // 时间轴排序：第1章 since 在 第2章 since 前，无 since 的排最后
    const kBlock = md.slice(md.indexOf('- **林渡**'));
    const i1 = kBlock.indexOf('（自 第一章）');
    const i2 = kBlock.indexOf('（自 第二章）');
    const iNone = kBlock.indexOf('无锚事实');
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(iNone);
  });

  it('clock 表按行内首个可定位章序排序，查不到的保持原相对序在后', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['manuscript/卷一/第2章.md'], storyDay: '第2日' },
        { chapters: ['manuscript/卷一/第1章.md'], storyDay: '第1日' },
        { chapters: ['manuscript/卷外/未知.md'], storyDay: '第9日' },
      ],
    };
    const order = [
      { relPath: 'manuscript/卷一/第1章.md', title: '一' },
      { relPath: 'manuscript/卷一/第2章.md', title: '二' },
    ];
    const md = renderLedgerMarkdown(ledger, { chapterOrder: order });
    const table = md.slice(md.indexOf('| Chapters |'));
    expect(table.indexOf('第1章.md')).toBeLessThan(table.indexOf('第2章.md'));
    expect(table.indexOf('卷外/未知.md')).toBeGreaterThan(table.indexOf('第2章.md'));
  });

  it('道具托管链步骤在 chapterOrder 提供时按章序排', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      props: [
        {
          name: '铜钱',
          holder: '林渡',
          custody: [
            { chapter: 'manuscript/卷一/第2章.md', holder: '阿九' },
            { chapter: 'manuscript/卷一/第1章.md', holder: '师父' },
            { chapter: 'manuscript/卷外/未知.md', holder: '路人' },
          ],
        },
      ],
    };
    const order = [
      { relPath: 'manuscript/卷一/第1章.md', title: '一' },
      { relPath: 'manuscript/卷一/第2章.md', title: '二' },
    ];
    const md = renderLedgerMarkdown(ledger, { chapterOrder: order });
    const row = md.slice(md.indexOf('- **铜钱**'));
    expect(row.indexOf('师父')).toBeLessThan(row.indexOf('阿九'));
    // 查不到的步骤保持原相对序排最后
    expect(row.indexOf('路人')).toBeGreaterThan(row.indexOf('阿九'));
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
      { op: 'knowledge', entry: { character: '林渡', knows: [{ fact: 'a' }] } },
    ];
    const l = applyOps(emptyLedger(), ops);
    expect(l.props).toHaveLength(1);
    expect(l.promises).toHaveLength(1);
    expect(l.knowledge).toHaveLength(1);
    const l2 = applyOps(l, [
      { op: 'prop', entry: { name: '铜钱', custody: [{ chapter: '第一章', holder: '林渡' }] } },
      { op: 'promise', entry: { id: 'P1', name: '铜钱来历', arc: 'resolved', setups: [], payoffs: [{ chapter: '第二章' }] } },
      { op: 'knowledge', entry: { character: '林渡', knows: [{ fact: 'a' }, { fact: 'b' }] } },
    ]);
    expect(l2.props).toHaveLength(1);
    expect(l2.props[0]!.custody).toHaveLength(1);
    expect(l2.promises[0]!.arc).toBe('resolved');
    expect(l2.knowledge[0]!.knows).toEqual([{ fact: 'a' }, { fact: 'b' }]);
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

  it('promise：arc 缺省落 planted（与 normalizeLedger 读路径同口径）', () => {
    const l = applyOps(emptyLedger(), [{ op: 'promise', entry: { id: 'P1', name: '青铜铃', setups: [], payoffs: [] } } as unknown as LedgerOp]);
    expect(l.promises[0]?.arc).toBe('planted');
  });

  it('promise：非法 arc 报错带条目 id 与允许枚举；缺 name 报错可定位', () => {
    expect(() =>
      applyOps(emptyLedger(), [{ op: 'promise', entry: { id: 'P9', name: 'x', arc: '埋设', setups: [], payoffs: [] } } as unknown as LedgerOp]),
    ).toThrow(/promise「P9」非法 arc: 埋设\(允许: planted/);
    expect(() =>
      applyOps(emptyLedger(), [{ op: 'promise', entry: { id: 'P2', setups: [], payoffs: [] } } as unknown as LedgerOp]),
    ).toThrow(/promise「P2」需要非空 name/);
  });

  it('clock.chapters 含非字符串元素抛守卫错误而非 TypeError', () => {
    expect(() =>
      applyOps(emptyLedger(), [{ op: 'clock', entry: { chapters: ['第一章', 2 as unknown as string] } } as unknown as LedgerOp]),
    ).toThrow(/chapters 必须是字符串数组/);
  });

  it('assertKnowledge：字符串元素原地升级为 {fact}，对象带 since/refs 保留', () => {
    const l = applyOps(emptyLedger(), [
      {
        op: 'knowledge',
        entry: {
          character: '林渡',
          knows: ['纯字符串事实', { fact: '对象事实', since: 'ch1', refs: ['F-1'] }],
        },
      } as unknown as LedgerOp,
    ]);
    expect(l.knowledge[0]!.knows).toEqual([{ fact: '纯字符串事实' }, { fact: '对象事实', since: 'ch1', refs: ['F-1'] }]);
  });

  it('assertKnowledge：对象缺 fact / fact 空抛中文错（与 normalize 读路径同口径）', () => {
    expect(() =>
      applyOps(emptyLedger(), [
        { op: 'knowledge', entry: { character: '林渡', knows: [{ fact: '  ' }] } } as unknown as LedgerOp,
      ]),
    ).toThrow(/knowledge 元素必须是非空字符串或带非空 fact 的对象/);
    expect(() =>
      applyOps(emptyLedger(), [
        { op: 'knowledge', entry: { character: '林渡', knows: [{ since: 'ch1' }] } } as unknown as LedgerOp,
      ]),
    ).toThrow(/knowledge 元素必须是非空字符串或带非空 fact 的对象/);
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

  it('clock-regression：同 thread 中文数字「第三日」→「第一日」倒退命中 MAJOR', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['ch1'], thread: '主', storyDay: '第三日' },
        { chapters: ['ch2'], thread: '主', storyDay: '第一日' },
      ],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
    ];
    const f = ledgerDiagnostics(ledger, order);
    expect(f.some((x) => x.code === 'clock-regression' && x.severity === 'MAJOR')).toBe(true);
  });

  it('clock-regression：阿拉伯数字「第5日」→「第3日」倒退命中', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['ch1'], thread: '主', storyDay: '第5日' },
        { chapters: ['ch2'], thread: '主', storyDay: '第3日' },
      ],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
    ];
    const f = ledgerDiagnostics(ledger, order);
    expect(f.some((x) => x.code === 'clock-regression')).toBe(true);
  });

  it('clock-regression：跨 thread 不报', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['ch1'], thread: '主', storyDay: '第五日' },
        { chapters: ['ch2'], thread: '支', storyDay: '第一日' },
      ],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
    ];
    expect(ledgerDiagnostics(ledger, order).some((x) => x.code === 'clock-regression')).toBe(false);
  });

  it('clock-regression：解析不出 N 跳过比较不报（宁缺毋滥）', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['ch1'], thread: '主', storyDay: '深秋未锚定' },
        { chapters: ['ch2'], thread: '主', storyDay: '第1日' },
      ],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
    ];
    expect(ledgerDiagnostics(ledger, order).some((x) => x.code === 'clock-regression')).toBe(false);
  });

  it('custody-chain-break(a)：托管链末端持有者与当前持有者矛盾 MAJOR', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      props: [
        {
          name: '铜钱',
          holder: '林渡',
          custody: [
            { chapter: 'ch1', holder: '师父' },
            { chapter: 'ch2', holder: '阿九' },
          ],
        },
      ],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
    ];
    const f = ledgerDiagnostics(ledger, order);
    expect(f.some((x) => x.code === 'custody-chain-break' && x.severity === 'MAJOR' && x.message.includes('矛盾'))).toBe(true);
  });

  it('custody-chain-break(a)：末端持有者与当前 holder 一致不报', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      props: [
        {
          name: '铜钱',
          holder: '林渡',
          custody: [
            { chapter: 'ch1', holder: '师父' },
            { chapter: 'ch2', holder: '林渡' },
          ],
        },
      ],
    };
    const order = [
      { relPath: 'ch1', title: '一' },
      { relPath: 'ch2', title: '二' },
    ];
    expect(
      ledgerDiagnostics(ledger, order).some((x) => x.code === 'custody-chain-break' && x.severity === 'MAJOR'),
    ).toBe(false);
  });

  it('custody-chain-break(b)：chapterOrder 非空时引用不存在的章 MODERATE', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      props: [
        {
          name: '铜钱',
          custody: [
            { chapter: 'ch1', holder: '林渡' },
            { chapter: '不存在的章.md', holder: '阿九' },
          ],
        },
      ],
    };
    const order = [{ relPath: 'ch1', title: '一' }];
    const f = ledgerDiagnostics(ledger, order);
    expect(
      f.some((x) => x.code === 'custody-chain-break' && x.severity === 'MODERATE' && x.message.includes('不存在的章')),
    ).toBe(true);
  });

  it('knowledge-no-knower：secret/selective 而无 knownBy → MODERATE/CANON；有知情人则不报', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      knowledge: [
        { character: '林渡', knows: [], visibility: 'secret' },
        { character: '阿九', knows: [], visibility: 'selective', knownBy: ['林渡'] },
        { character: '张三', knows: [], visibility: 'public' },
      ],
    };
    const f = ledgerDiagnostics(ledger);
    expect(f.some((x) => x.code === 'knowledge-no-knower' && x.severity === 'MODERATE' && x.category === 'CANON' && x.message.includes('林渡'))).toBe(true);
    expect(f.some((x) => x.message.includes('阿九'))).toBe(false);
    expect(f.some((x) => x.message.includes('张三'))).toBe(false);
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

  it('正文/标题含占位 token 不被二次替换（单趟替换）', () => {
    const work = makeWorkDir();
    const issueLines = Array.from({ length: 3 }, (_, i) => `CR-${String(i + 1).padStart(3, '0')} | 1:1 | MINOR | CONT | "x" | why | fix | LINE`);
    writeTree(work, {
      // 章文件名与正文都带占位 token 字面量，不得被后续替换扫到
      'manuscript/第1章·{{章节内容}}.md': '---\ntitle: 第1章\n---\n正文提到 {{问题日志尾部}} 与 {{章节内容}}。',
      'editorial_notes/issues.md': issueLines.join('\n'),
    });
    writeLedger(work, sampleLedger());
    const { slice } = ledgerSlice(work, 'manuscript/第1章·{{章节内容}}.md', undefined, 'editorial_notes/issues.md');
    // 模板自身的占位符已正确替换
    expect(slice).toContain('# Reader Ledger'); // 账本切片注入
    expect(slice).toContain('CR-001'); // 问题日志尾部注入
    // 用户可控文本里的字面量占位 token 原样保留
    expect(slice).toContain('### 第1章·{{章节内容}}');
    expect(slice).toContain('正文提到 {{问题日志尾部}} 与 {{章节内容}}。');
  });

  it('budget 闸：传 budget 时切片走索引层（压预算+附注入构成），缺省行为零变', () => {
    const work = makeWorkDir();
    // 造 300 章让账本切片在全量渲染下显著超预算
    const files: Record<string, string> = {};
    for (let i = 1; i <= 300; i++) files[`manuscript/第${i}章.md`] = '---\ntitle: 章\n---\n正文。';
    writeTree(work, files);
    // 账本带大量伏笔（渲染全量很大）
    const promises = Array.from({ length: 800 }, (_, i) => ({ id: `P-${i}`, name: `伏笔${i}`, arc: 'planted' as const, setups: [{ chapter: `manuscript/第${(i % 300) + 1}章.md` }], payoffs: [] }));
    writeLedger(work, { ...emptyLedger(), promises });
    // 缺省：全量渲染（行为零变——slice 含全部伏笔名，无附加字段）
    const base = ledgerSlice(work, 'manuscript/第300章.md');
    expect(base.slice).toContain('伏笔0');
    expect(base).not.toHaveProperty('ledgerSliceChars');
    // 传 budget：压进预算
    const cut = ledgerSlice(work, 'manuscript/第300章.md', undefined, undefined, { budget: 30_000 }) as typeof base & { ledgerSliceChars: number; ledgerSliceComposition: Record<string, number> };
    expect(cut.slice.length).toBeLessThan(base.slice.length);
    expect(cut.ledgerSliceChars).toBeLessThanOrEqual(30_000);
    expect(cut.ledgerSliceComposition).toBeDefined();
    // 索引切片仍含承重伏笔（区间在 300 章生效）
    expect(cut.slice).toContain('伏笔');
    // 章守卫不变：非 manuscript 章照旧抛错
    expect(() => ledgerSlice(work, '.novel/ledger.md', undefined, undefined, { budget: 1000 })).toThrow(/manuscript/);
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

  it('章读取失败不静默：console.warn 带路径与错误，结果附 skipped 清单', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。',
      'manuscript/第2章.md': '---\ntitle: 第2章\n---\n初春的风。盛夏的日。',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor) => {
      // 只拦第2章的读取；账本文件不存在走 ENOENT 分支不受影响
      if (String(file).includes('第2章')) throw new Error('模拟不可读');
      return realRead(file, 'utf8');
    }) as typeof fs.readFileSync);
    try {
      const res = diagnosticsForWork(work);
      // 第2章没读到 → 其季节冲突不产生，且明确记入 skipped
      expect(res.findings.some((f) => f.code === 'season-conflict')).toBe(false);
      expect(res.skipped).toEqual([{ path: 'manuscript/第2章.md', reason: '模拟不可读' }]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('第2章');
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
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

const SLICE_ORDER: { relPath: string; title: string }[] = [
  { relPath: 'manuscript/卷一/第1章.md', title: '第1章' },
  { relPath: 'manuscript/卷一/第2章.md', title: '第2章' },
  { relPath: 'manuscript/卷一/第3章.md', title: '第3章' },
  { relPath: 'manuscript/卷一/第4章.md', title: '第4章' },
];

describe('filterLedgerForChapter（按章过滤，批三-3）', () => {
  it('relPath 不在 chapterOrder 内 → 返回 null', () => {
    expect(filterLedgerForChapter(emptyLedger(), SLICE_ORDER, 'manuscript/卷一/不存在.md')).toBeNull();
  });

  it('clock：跨度行含当前/过去章即保留；整段都在未来的行才删', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['manuscript/卷一/第1章.md'], storyDay: '第1日' },
        { chapters: ['manuscript/卷一/第2章.md'], storyDay: '第2日' },
        { chapters: ['manuscript/卷一/第3章.md'], storyDay: '第3日' }, // 未来章 → 删
        { chapters: ['manuscript/旧/未知.md'], storyDay: '第9日' }, // 未知章 → 留
        { chapters: ['manuscript/卷一/第1章.md', 'manuscript/卷一/第3章.md'], storyDay: '双章' }, // 跨第1-3章,第2章仍在跨度内 → 留
        { chapters: ['manuscript/卷一/第3章.md', 'manuscript/卷一/第4章.md'], storyDay: '未来跨度' }, // 整段未来 → 删
      ],
    };
    const out = filterLedgerForChapter(ledger, SLICE_ORDER, 'manuscript/卷一/第2章.md')!;
    expect(out.clock.map((r) => r.chapters)).toEqual([
      ['manuscript/卷一/第1章.md'],
      ['manuscript/卷一/第2章.md'],
      ['manuscript/旧/未知.md'],
      ['manuscript/卷一/第1章.md', 'manuscript/卷一/第3章.md'],
    ]);
  });

  it('props：托管链裁到 ≤idx，链空整条删，其余字段保留', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      props: [
        {
          name: '铜钱',
          type: '信物',
          holder: '林渡',
          status: '磨亮',
          custody: [
            { chapter: 'manuscript/卷一/第1章.md', holder: '师父' },
            { chapter: 'manuscript/卷一/第3章.md', holder: '阿九' }, // 未来链节 → 裁掉
          ],
        },
        { name: '木剑', holder: '路人', custody: [{ chapter: 'manuscript/卷一/第3章.md', holder: '路人' }] }, // 裁后链空 → 整条删
        { name: '信物', custody: [{ chapter: 'manuscript/旧/未知.md', holder: '?' }] }, // 未知章 → 留
      ],
    };
    const out = filterLedgerForChapter(ledger, SLICE_ORDER, 'manuscript/卷一/第2章.md')!;
    expect(out.props.map((p) => p.name)).toEqual(['铜钱', '信物']);
    const tong = out.props[0]!;
    expect(tong.custody).toEqual([{ chapter: 'manuscript/卷一/第1章.md', holder: '师父' }]);
    expect(tong.holder).toBe('林渡'); // 链裁掉后当前 holder 原样保留
    expect(tong.type).toBe('信物');
  });

  it('promises：未来 planted 删、过去 resolution 删、当前章 resolution 必留、未知章保留、多节伏笔仍存活即留', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      promises: [
        { id: 'P-future', name: '未来埋设', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第3章.md' }], payoffs: [] },
        { id: 'P-now', name: '当前埋设', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第2章.md' }], payoffs: [] },
        { id: 'P-past-r', name: '早回收', arc: 'resolved', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [{ chapter: 'manuscript/卷一/第1章.md' }] },
        { id: 'P-now-r', name: '当前回收', arc: 'resolved', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [{ chapter: 'manuscript/卷一/第2章.md' }] },
        { id: 'P-un', name: '未知章', arc: 'planted', setups: [{ chapter: 'manuscript/旧/未知.md' }], payoffs: [{ chapter: 'manuscript/旧/未知2.md' }] },
        // 已埋过第1章、第3章还要推进 → 存活保留(只删「全部埋设点都在未来」的未开埋伏笔)
        { id: 'P-multi', name: '多埋设含未来', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第1章.md' }, { chapter: 'manuscript/卷一/第3章.md' }], payoffs: [] },
        // 第1章收了一节、第3章还有一节待收 → 存活保留(只删「全部回收点都在过去」的已完结伏笔)
        { id: 'P-multi-r', name: '多节回收半完成', arc: 'pending', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [{ chapter: 'manuscript/卷一/第1章.md' }, { chapter: 'manuscript/卷一/第3章.md' }] },
      ],
    };
    const out = filterLedgerForChapter(ledger, SLICE_ORDER, 'manuscript/卷一/第2章.md')!;
    expect(out.promises.map((p) => p.id)).toEqual(['P-now', 'P-now-r', 'P-un', 'P-multi', 'P-multi-r']);
  });

  it('knowledge：since 未来删、无 since/≤idx/未知章留、doesNotKnow 同口径、refs 透传', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      knowledge: [
        {
          character: '林渡',
          knows: [
            { fact: '无锚事实' },
            { fact: '第1章得知', since: 'manuscript/卷一/第1章.md' },
            { fact: '第3章得知', since: 'manuscript/卷一/第3章.md' }, // 未来 → 删
            { fact: '未知章得知', since: 'manuscript/旧/未知.md' },
            { fact: '带回指', since: 'manuscript/卷一/第1章.md', refs: ['P1', 'P2'] },
          ],
          doesNotKnow: [{ fact: '他不知道的' }, { fact: '未来才知道', since: 'manuscript/卷一/第4章.md' }],
          visibility: 'secret',
          knownBy: ['作者'],
        },
      ],
    };
    const out = filterLedgerForChapter(ledger, SLICE_ORDER, 'manuscript/卷一/第2章.md')!;
    const k = out.knowledge[0]!;
    expect(k.knows).toEqual([
      { fact: '无锚事实' },
      { fact: '第1章得知', since: 'manuscript/卷一/第1章.md' },
      { fact: '未知章得知', since: 'manuscript/旧/未知.md' },
      { fact: '带回指', since: 'manuscript/卷一/第1章.md', refs: ['P1', 'P2'] },
    ]);
    expect(k.doesNotKnow).toEqual([{ fact: '他不知道的' }]);
    expect(k.visibility).toBe('secret');
    expect(k.knownBy).toEqual(['作者']);
  });

  it('其余各节（注册表/PROTECT/tripwires/extra）原样透传且不 mutate 入参', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      doNotReexplain: ['a'],
      protect: [{ item: 'b', reason: 'r' }],
      tripwires: ['c'],
      extra: { custom: { x: 1 } },
    };
    const before = JSON.stringify(ledger);
    const out = filterLedgerForChapter(ledger, SLICE_ORDER, 'manuscript/卷一/第1章.md')!;
    expect(out.doNotReexplain).toEqual(['a']);
    expect(out.protect).toEqual([{ item: 'b', reason: 'r' }]);
    expect(out.tripwires).toEqual(['c']);
    expect(out.extra).toEqual({ custom: { x: 1 } });
    expect(JSON.stringify(ledger)).toBe(before);
  });

  it('第1章切片：unknown/当前章行保留、未来一切删除，promises 需无未来埋设', () => {
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [{ chapters: ['manuscript/卷一/第1章.md'] }, { chapters: ['manuscript/卷一/第2章.md'] }],
      promises: [
        { id: 'P1', name: 'a', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [] },
        { id: 'P2', name: 'b', arc: 'resolved', setups: [{ chapter: 'manuscript/卷一/第1章.md' }], payoffs: [{ chapter: 'manuscript/卷一/第2章.md' }] },
      ],
    };
    const out = filterLedgerForChapter(ledger, SLICE_ORDER, 'manuscript/卷一/第1章.md')!;
    expect(out.clock).toHaveLength(1); // 只留第1章行
    // P2 resolution 在未来（第2章 ≥ idx=0）→ 保留（未在本章发生，不算过去噪音）
    expect(out.promises.map((p) => p.id)).toEqual(['P1', 'P2']);
  });
});

describe('ledger_chapter_slice（按章过滤的账本视图，批三-3）', () => {
  it('found=true：返回过滤后 ledger、渲染 slice 与 chapterTitle', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第1章.md': '---\ntitle: 第1章\n---\n正文一。',
      'manuscript/卷一/第2章.md': '---\ntitle: 第2章\n---\n正文二。',
      'manuscript/卷一/第3章.md': '---\ntitle: 第3章\n---\n正文三。',
    });
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [{ chapters: ['manuscript/卷一/第1章.md'], storyDay: '第1日' }],
      promises: [
        { id: 'P-now', name: '现在', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第2章.md' }], payoffs: [] },
        { id: 'P-future', name: '未来', arc: 'planted', setups: [{ chapter: 'manuscript/卷一/第3章.md' }], payoffs: [] },
      ],
    };
    writeLedger(work, ledger);
    const res = ledgerChapterSlice(work, 'manuscript/卷一/第2章.md');
    expect(res.found).toBe(true);
    expect(res.chapterTitle).toBe('第2章'); // chapterOrder title = 文件名去 .md
    expect(res.workDir).toBe(path.resolve(work));
    expect(res.chapterRelPath).toBe('manuscript/卷一/第2章.md');
    expect(res.ledger.promises.map((p) => p.id)).toEqual(['P-now']);
    expect(res.ledger.clock).toHaveLength(1);
    expect(res.slice).toContain('## Position / Clock table');
    expect(res.slice).toContain('**P-now**');
    expect(res.slice).not.toContain('**P-future**');
  });

  it('found=false：章不在序内（文件不存在）→ 空账本 + 空 slice + chapterTitle=null', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第1章.md': '正文。' });
    writeLedger(work, sampleLedger());
    const res = ledgerChapterSlice(work, 'manuscript/卷一/不存在的章.md');
    expect(res.found).toBe(false);
    expect(res.chapterTitle).toBeNull();
    expect(res.ledger).toEqual(emptyLedger());
    expect(res.slice).toBe('');
  });

  it('守卫：chapterRelPath 非 manuscript/ 内 .md 一律拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '正文。',
      '全稿-20260101.txt': '全稿',
      '.novel/ledger.md': serializeLedger(emptyLedger()),
    });
    expect(() => ledgerChapterSlice(work, '全稿-20260101.txt')).toThrow(/manuscript/);
    expect(() => ledgerChapterSlice(work, '.novel/ledger.md')).toThrow(/manuscript/);
    expect(() => ledgerChapterSlice(work, '../外面.md')).toThrow();
  });

  it('ledgerPath 走账本白名单：manuscript/ 内文件拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    expect(() => ledgerChapterSlice(work, 'manuscript/第1章.md', 'manuscript/第1章.md')).toThrow(/ledgerPath/);
  });
});

describe('write_meta（书级元数据写入，批三-3）', () => {
  it('新文件：原子写入 .novel/style.md，返回 { ok, path, bytes } 且无 .tmp 残留', () => {
    const work = makeWorkDir();
    const content = '# 书风格\n\n正文风格说明。';
    const res = writeMeta(work, '.novel/style.md', content);
    expect(res.ok).toBe(true);
    expect(res.path).toBe('.novel/style.md');
    expect(res.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(fs.readFileSync(path.join(work, '.novel/style.md'), 'utf8')).toBe(content);
    expect(fs.readdirSync(path.join(work, '.novel'))).toEqual(['style.md']);
  });

  it('白名单：拒绝 manuscript/、editorial_notes/、.novel/ 子目录与根目录 .md', () => {
    const work = makeWorkDir();
    expect(() => writeMeta(work, 'manuscript/第1章.md', 'x')).toThrow(/只允许/);
    expect(() => writeMeta(work, 'editorial_notes/issues.md', 'x')).toThrow(/只允许/);
    expect(() => writeMeta(work, '.novel/notes/book.md', 'x')).toThrow(/只允许/);
    expect(() => writeMeta(work, 'AGENTS.md', 'x')).toThrow(/只允许/);
  });

  it('目标已存在且可解析为账本 → 拒写，报错指明 ledger_upsert，原账本不被破坏', () => {
    const work = makeWorkDir();
    writeLedger(work, sampleLedger());
    expect(() => writeMeta(work, '.novel/ledger.md', '# 会被拒的元数据')).toThrow(/账本请用 ledger_upsert/);
    expect(fs.readFileSync(path.join(work, '.novel/ledger.md'), 'utf8')).toContain('铜钱'); // 原样保留
    expect(readLedger(work).ledger).toEqual(sampleLedger());
  });

  it('非账本元数据文件可覆盖，写前对旧版本快照进 .novel/history/', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/style.md': '旧风格。' });
    writeMeta(work, '.novel/style.md', '新风格。');
    expect(fs.readFileSync(path.join(work, '.novel/style.md'), 'utf8')).toContain('新风格');
    const snapDir = path.join(work, '.novel', 'history', '.novel__style');
    const snaps = fs.readdirSync(snapDir).filter((n) => n.endsWith('.md'));
    expect(snaps).toHaveLength(1);
    expect(fs.readFileSync(path.join(snapDir, snaps[0]!), 'utf8')).toBe('旧风格。');
  });

  it('新文件首写不产生快照', () => {
    const work = makeWorkDir();
    writeMeta(work, '.novel/style.md', '风格。');
    expect(fs.existsSync(path.join(work, '.novel', 'history'))).toBe(false);
  });
});

describe('章序修复（编号感知，批三-3 顺带修复）', () => {
  it('12 章作品 chapterOrderForWork 数值序：第2章 < 第10章（非路径字典序）', () => {
    const work = makeWorkDir();
    const files: Record<string, string> = {};
    for (let n = 1; n <= 12; n++) files[`manuscript/卷一/第${n}章.md`] = `---\ntitle: 第${n}章\n---\n正文 ${n}。`;
    writeTree(work, files);
    const order = chapterOrderForWork(work);
    expect(order).toHaveLength(12);
    expect(order.map((c) => c.relPath)).toEqual(Array.from({ length: 12 }, (_, i) => `manuscript/卷一/第${i + 1}章.md`));
  });

  it('writeLedger 渲染 clock 表按编号序：第2章 在 第10章 前（字典序会把第10章排到第2章前）', () => {
    const work = makeWorkDir();
    const files: Record<string, string> = {};
    for (let n = 1; n <= 12; n++) files[`manuscript/卷一/第${n}章.md`] = `正文 ${n}。`;
    writeTree(work, files);
    const ledger: Ledger = {
      ...emptyLedger(),
      clock: [
        { chapters: ['manuscript/卷一/第10章.md'], storyDay: '第10日' },
        { chapters: ['manuscript/卷一/第2章.md'], storyDay: '第2日' },
        { chapters: ['manuscript/卷一/第1章.md'], storyDay: '第1日' },
        { chapters: ['manuscript/卷一/第11章.md'], storyDay: '第11日' },
        { chapters: ['manuscript/卷一/第12章.md'], storyDay: '第12日' },
      ],
    };
    writeLedger(work, ledger, '.novel/review.md');
    const content = fs.readFileSync(path.join(work, '.novel/review.md'), 'utf8');
    const table = content.slice(content.indexOf('| Chapters |'));
    for (const n of [1, 2, 10, 11, 12]) expect(table.indexOf(`第${n}章.md`)).toBeGreaterThan(-1);
    expect(table.indexOf('第1章.md')).toBeLessThan(table.indexOf('第2章.md'));
    expect(table.indexOf('第2章.md')).toBeLessThan(table.indexOf('第10章.md'));
    expect(table.indexOf('第10章.md')).toBeLessThan(table.indexOf('第11章.md'));
    expect(table.indexOf('第11章.md')).toBeLessThan(table.indexOf('第12章.md'));
  });

  it('diagnostics 章序数值化：第10章 planted+due=5 不误报逾期（字典序会把第10章排到第2位→误报）', () => {
    const work = makeWorkDir();
    const files: Record<string, string> = {};
    for (let n = 1; n <= 12; n++) files[`manuscript/卷一/第${n}章.md`] = `正文 ${n}。`;
    writeTree(work, files);
    upsertLedger(work, [
      {
        op: 'promise',
        entry: {
          id: 'P1', name: 'x', arc: 'planted', heat: 'HOT', due: 5,
          setups: [{ chapter: 'manuscript/卷一/第10章.md' }], payoffs: [],
        },
      },
    ]);
    const res = diagnosticsForWork(work);
    // 数值序：第10章之后只剩 2 章（< due=5）→ 不逾期；字典序会把第10章排第2位 → 误报逾期
    expect(res.findings.some((f) => f.code === 'overdue-promise')).toBe(false);
    expect(res.findings.some((f) => f.code === 'dangling-promise')).toBe(true);
  });
});

describe('角色卡（4.3 角色维）', () => {
  it('character op 按 name upsert；states 保真；remove character', () => {
    const entry = { name: '克莱恩', aliases: ['世界'], role: '值夜者', states: [{ field: '位置', value: '廷根', since: 'manuscript/第1章.md' }] };
    const up = applyOps(emptyLedger(), [{ op: 'character', entry }]);
    expect(up.characters?.length).toBe(1);
    expect(up.characters?.[0]!.states?.[0]!.value).toBe('廷根');
    const moved = applyOps(up, [{ op: 'character', entry: { ...entry, states: [{ field: '位置', value: '贝克兰德', since: 'manuscript/第10章.md' }] } }]);
    expect(moved.characters?.length).toBe(1);
    expect(moved.characters?.[0]!.states?.[0]!.value).toBe('贝克兰德');
    const removed = applyOps(moved, [{ op: 'remove', dimension: 'character', name: '克莱恩' }]);
    expect(removed.characters?.length).toBe(0);
  });

  it('serialize 空表省略（旧账本文件级零 diff）；非空表写入回读保真', () => {
    const old = emptyLedger();
    const text = serializeLedger(old);
    expect(text).not.toContain('characters');
    expect(parseLedger(text)).toEqual(old);
    const withChar = applyOps(old, [{ op: 'character', entry: { name: '克莱恩', kind: 'character', description: '主角' } }]);
    const back = parseLedger(serializeLedger(withChar));
    expect(back.characters?.length).toBe(1);
    expect(back.characters?.[0]!.name).toBe('克莱恩');
    expect(back.characters?.[0]!.description).toBe('主角');
  });

  it('确定性诊断：别名冲突/状态同章/引用未解析（角色维未启用=静默）', () => {
    const empty = ledgerDiagnostics(emptyLedger());
    expect(empty.some((f) => f.code.startsWith('character-'))).toBe(false);
    const bad = applyOps(emptyLedger(), [
      { op: 'character', entry: { name: '克莱恩', aliases: ['世界'] } },
      { op: 'character', entry: { name: '克莱恩·莫雷蒂', aliases: ['世界'] } },
      { op: 'character', entry: { name: '老尼尔', states: [{ field: '位置', value: 'A', since: 'manuscript/第3章.md' }, { field: '位置', value: 'B', since: 'manuscript/第3章.md' }] } },
      { op: 'promise', entry: { id: 'P-1', name: '诺言', arc: 'planted', setups: [], payoffs: [], links: { characters: ['陌生人'] } } },
    ]);
    const d = ledgerDiagnostics(bad);
    expect(d.some((f) => f.code === 'character-alias-conflict')).toBe(true);
    expect(d.some((f) => f.code === 'character-state-order')).toBe(true);
    expect(d.some((f) => f.code === 'character-ref-unresolved')).toBe(true);
  });
});

describe('4.3 评审修复回归', () => {
  it('动态层保护：不带 states 的 character upsert 保留既有 states；带 states 整体替换', () => {
    const withStates = applyOps(emptyLedger(), [{ op: 'character', entry: { name: '克莱恩', states: [{ field: '位置', value: '廷根', since: 'manuscript/第1章.md' }] } }]);
    const staticOnly = applyOps(withStates, [{ op: 'character', entry: { name: '克莱恩', role: '值夜者' } }]);
    expect(staticOnly.characters?.[0]!.role).toBe('值夜者');
    expect(staticOnly.characters?.[0]!.states?.[0]!.value).toBe('廷根');
    const rewritten = applyOps(staticOnly, [{ op: 'character', entry: { name: '克莱恩', states: [{ field: '位置', value: '贝克兰德', since: 'manuscript/第10章.md' }] } }]);
    expect(rewritten.characters?.[0]!.states?.length).toBe(1);
    expect(rewritten.characters?.[0]!.states?.[0]!.value).toBe('贝克兰德');
  });

  it('动态层直写拦截：assertNoDirectStateWrite 拒带 states 的 character op', async () => {
    const { assertNoDirectStateWrite } = await import('../src/ledger.js');
    expect(() => assertNoDirectStateWrite([{ op: 'character', entry: { name: 'X', states: [{ field: '位置', value: 'y', since: 'manuscript/第1章.md' }] } }])).toThrow(/裁决回路/);
    expect(() => assertNoDirectStateWrite([{ op: 'character', entry: { name: 'X' } }])).not.toThrow();
    expect(() => assertNoDirectStateWrite([{ op: 'promise', entry: { id: 'P-1', name: 'n', arc: 'planted', setups: [], payoffs: [] } }])).not.toThrow();
  });

  it('states 残缺项容错：parse 丢弃 field/value/since 缺失项（防回写垃圾）', () => {
    const yaml = '---\ncharacters:\n  - name: 克莱恩\n    states:\n      - field: \"\"\n        value: \"\"\n        since: \"\"\n      - field: 位置\n        value: 廷根\n        since: manuscript/第1章.md\n---\n# Reader Ledger\n';
    const parsed = parseLedger(yaml);
    expect(parsed.characters?.[0]!.states?.length).toBe(1);
  });

  it('旧账本近似 byte 级零 diff：非角色 op 写入后文件不出现 characters 键', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 1\n---\n正文。' });
    writeLedger(work, { ...emptyLedger(), promises: [{ id: 'P-1', name: '诺言', arc: 'planted', setups: [{ chapter: 'manuscript/第1章.md', quote: 'q' }], payoffs: [] }] });
    const before = readLedger(work).ledger;
    upsertLedger(work, [{ op: 'prop', entry: { name: '铜哨', custody: [{ chapter: 'manuscript/第1章.md' }] } }]);
    const after = readLedger(work).ledger;
    expect(JSON.stringify(after)).not.toContain('"characters":[]');
    expect(after.promises.length).toBe(1);
    expect(before.promises.length).toBe(1);
  });

  it('character-state-order 非相邻重复也报（ch3,ch5,ch3）', () => {
    const bad = applyOps(emptyLedger(), [
      { op: 'character', entry: { name: '老尼尔', states: [
        { field: '位置', value: 'A', since: 'manuscript/第3章.md' },
        { field: '位置', value: 'B', since: 'manuscript/第5章.md' },
        { field: '位置', value: 'C', since: 'manuscript/第3章.md' },
      ] } },
    ]);
    expect(ledgerDiagnostics(bad).some((f) => f.code === 'character-state-order')).toBe(true);
  });
});
