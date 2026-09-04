/** character-norm.test.ts —— 角色维别名归一（reference/05 §角色维：归一化+单调性确定性诊断；4.3）。 */
import { describe, expect, it } from 'vitest';
import { matchName, nameVariants, normalizeName, resolveNameRefs, samePersonVariants } from '../src/character-norm.js';
import { emptyLedger, type CharacterEntry, type Ledger } from '../src/ledger.js';

const DICT: CharacterEntry[] = [
  { name: '克莱恩', aliases: ['克莱恩·莫雷蒂', '世界', '福尔摩斯· Moriarty'.trim()] },
  { name: '老尼尔', role: '值夜者' },
  { name: '铜哨', kind: 'lore', description: '道具型设定登记复用同模式' },
];

describe('归一化与匹配', () => {
  it('normalizeName：去空白/间隔点、小写', () => {
    expect(normalizeName(' 克莱恩·莫雷蒂 ')).toBe('克莱恩莫雷蒂');
  });

  it('称谓形态展开：克莱恩先生→克莱恩；老尼尔→尼尔；单字不产出（防碎片键）', () => {
    expect(nameVariants('克莱恩先生')).toContain('克莱恩');
    expect(nameVariants('老尼尔')).toContain('尼尔');
    expect(nameVariants('阿蒙')).toEqual(['阿蒙']); // 剥后单字不收
  });

  it('matchName：主名/别名/称谓形态三路命中并标记 via', () => {
    const hit1 = matchName('克莱恩', DICT);
    expect(hit1?.via).toBe('name');
    const hit2 = matchName('世界', DICT);
    expect(hit2?.via).toBe('alias');
    expect(hit2?.entry.name).toBe('克莱恩');
    const hit3 = matchName('克莱恩先生', DICT);
    expect(hit3?.entry.name).toBe('克莱恩');
    expect(matchName('陌生人', DICT)).toBeNull();
  });

  it('同一人多写法检测：编辑距离 1 未登记写法入嫌疑', () => {
    const text = '克莱恩走进房间。克菜恩坐下了。克莱恩说……'.replace('克菜恩', '克莱思');
    const suspects = samePersonVariants(text, DICT);
    expect(suspects.some((s) => s.variant === '克莱思' && s.likely === '克莱恩')).toBe(true);
  });
});

describe('人名字段可解析引用（可选解析，未解析不报错只入清单）', () => {
  const base = (): Ledger => ({
    ...emptyLedger(),
    promises: [{ id: 'P-1', name: '诺言', arc: 'planted', setups: [], payoffs: [], links: { characters: ['克莱恩', '陌生人'] } }],
    knowledge: [{ character: '老尼尔', knows: [] }],
    props: [{ name: '铜哨', holder: '克莱恩', custody: [{ chapter: 'c1', holder: '神秘人' }] }],
  });

  it('角色维未启用 → enabled:false 不产噪音', () => {
    const r = resolveNameRefs(base());
    expect(r.enabled).toBe(false);
    expect(r.unresolved).toEqual([]);
  });

  it('启用后：命中计入 resolved，未命中入清单（别名/称谓形态可命中）', () => {
    const r = resolveNameRefs({ ...base(), characters: DICT });
    expect(r.enabled).toBe(true);
    // 命中 3：promise.links 克莱恩、knowledge 老尼尔、prop holder 克莱恩；未命中 2：陌生人（link）、神秘人（托管链）
    expect(r.resolved).toBe(3);
    expect(r.unresolved.map((u) => u.name).sort()).toEqual(['神秘人', '陌生人']);
  });
});

describe('4.3 评审修复回归', () => {
  it('matchName 两遍构典：派生变体不抢占他卡精确主名（老约翰 vs 约翰）', () => {
    const dict: CharacterEntry[] = [{ name: '老约翰' }, { name: '约翰' }];
    expect(matchName('约翰', dict)?.entry.name).toBe('约翰');
    expect(matchName('老约翰', dict)?.entry.name).toBe('老约翰');
  });

  it('isExcludedName：功能词不入超域候选（排除表导出）', async () => {
    const { isExcludedName } = await import('../src/character-norm.js');
    expect(isExcludedName('今天')).toBe(true);
    expect(isExcludedName('克莱恩')).toBe(false);
  });

  it('文档性记档：全角拉丁不折叠、繁体需显式登记（现状口径钉扎）', () => {
    expect(normalizeName('ＫＬＡＩＮ')).toBe('ｋｌａｉｎ'); // 全角不转半角——现状如此，词典制 4.3+ 再校准
    const dict: CharacterEntry[] = [{ name: '克莱恩' }];
    expect(matchName('克萊恩', dict)).toBeNull(); // 繁体异形不命中——需显式登记别名
  });
});
