/**
 * create-rename-move.test.ts —— 章节/卷的生产与组织：建章/建卷编号接续、模板、
 * 改名（编号保留/不匹配模式）、卷内重排（事务化重编号 1..N）、同位置幂等、
 * 跨卷拒绝、目标名冲突整体拒绝、同名冲突抛错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.js';
import {
  createChapter,
  createVolume,
  moveChapter,
  moveVolume,
  renameChapter,
  renameVolume,
} from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 章内容：frontmatter title 与文件名一致（数据模型事实）。 */
function chapter(title: string, body = '正文内容。'): string {
  return `---\ntitle: ${title}\nstatus: 草稿\n---\n\n${body}`;
}


/** 编号感知排序：第一章 < 第二章（纯字典序会把 三 排在 二 前，U+4E09 < U+4E8C）。 */
const NUM_RE = /^第(\d+|[一二三四五六七八九十百]+)[章卷]/;
const CN_D: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function numOf(s: string): number {
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  let t = 0, sec = 0, n = 0;
  for (const ch of s) {
    if (ch === '百') { t += (sec + (n || 1)) * 100; sec = 0; n = 0; }
    else if (ch === '十') { sec += (n || 1) * 10; n = 0; }
    else n = CN_D[ch] ?? 0;
  }
  return t + sec + n;
}
function sortedNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ma = NUM_RE.exec(a);
    const mb = NUM_RE.exec(b);
    if (ma && mb) {
      const na = numOf(ma[1]!);
      const nb = numOf(mb[1]!);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

describe('create_chapter', () => {
  it('编号接续：legacy 阿拉伯编号 第1章/第2章 时新建得 第三章（汉字规范名）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章·少年.md': chapter('第1章·少年'),
      'manuscript/第2章·客栈.md': chapter('第2章·客栈'),
    });
    const res = createChapter(work, undefined, '风起');
    expect(res).toEqual({ ok: true, relPath: 'manuscript/第三章·风起.md' });
    expect(fs.existsSync(path.join(work, 'manuscript/第三章·风起.md'))).toBe(true);
  });

  it('卷内编号接续，且根目录散章不影响卷内编号', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷/第1章·少年.md': chapter('第1章·少年'),
      'manuscript/第一卷/第3章·客栈.md': chapter('第3章·客栈'),
      'manuscript/第2章·根章.md': chapter('第2章·根章'),
    });
    expect(createChapter(work, '第一卷', '风起').relPath).toBe('manuscript/第一卷/第四章·风起.md');
    // 根卷只认根下的章（第2章），与第一卷无关
    expect(createChapter(work).relPath).toBe('manuscript/第三章·新章.md');
  });

  it('模板含 title/status/id，goal 传了才写', () => {
    const work = makeWorkDir();
    const res1 = createChapter(work, undefined, '少年');
    const content1 = fs.readFileSync(path.join(work, ...res1.relPath.split('/')), 'utf8');
    expect(content1).toMatch(/^---\ntitle: 第一章·少年\nstatus: 草稿\nid: [0-9a-f-]+\n---\n\n$/);
    expect(content1).not.toContain('goal');
    expect(parseFrontmatter(content1)).toMatchObject({ title: '第一章·少年', status: '草稿', id: expect.any(String) });

    const res2 = createChapter(work, undefined, '客栈', 5000);
    const content2 = fs.readFileSync(path.join(work, ...res2.relPath.split('/')), 'utf8');
    expect(content2).toMatch(/^---\ntitle: 第二章·客栈\nstatus: 草稿\nid: [0-9a-f-]+\ngoal: 5000\n---\n\n$/);
    expect(parseFrontmatter(content2).goal).toBe(5000);
  });

  it('拒绝带编号前缀的 title、带路径分隔符的 volume', () => {
    const work = makeWorkDir();
    expect(() => createChapter(work, undefined, '第5章·少年')).toThrow(/编号前缀/);
    expect(() => createChapter(work, '第一卷/子')).toThrow(/分隔符/);
    expect(() => createChapter(work, '..')).toThrow();
  });

  it('同名文件已存在抛错（不覆盖）', () => {
    const work = makeWorkDir();
    // 目录名与目标文件同名：编号计数跳过目录，但存在性检查拦下（不覆盖任何已存在条目）
    writeTree(work, { 'manuscript/第一章·少年.md/占位.txt': 'x' });
    expect(() => createChapter(work, undefined, '少年')).toThrow(/已存在/);
    expect(fs.statSync(path.join(work, 'manuscript/第一章·少年.md')).isDirectory()).toBe(true);
  });
});

describe('create_volume', () => {
  it('编号接续（只认匹配「第N卷」模式的目录），默认标题 新卷', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript/第1卷·风起'), { recursive: true }); // legacy 阿拉伯编号
    expect(createVolume(work, '云涌')).toEqual({ ok: true, volumePath: 'manuscript/第二卷·云涌' });
    expect(createVolume(work)).toEqual({ ok: true, volumePath: 'manuscript/第三卷·新卷' });
    expect(fs.statSync(path.join(work, 'manuscript/第二卷·云涌')).isDirectory()).toBe(true);
  });

  it('拒绝带编号前缀的 title 与路径分隔符；同名卷目录已存在抛错', () => {
    const work = makeWorkDir();
    expect(() => createVolume(work, '第3卷·风起')).toThrow(/编号前缀/);
    expect(() => createVolume(work, '风/起')).toThrow(/分隔符/);
    // 同名条目是文件而非目录：编号计数跳过，但存在性检查拦下（不覆盖）
    writeTree(work, { 'manuscript/第一卷·风起': '不是目录' });
    expect(() => createVolume(work, '风起')).toThrow(/已存在/);
  });
});

describe('rename_chapter', () => {
  it('保留编号只换标题，同步 frontmatter title，其余字段与正文不动', () => {
    const work = makeWorkDir();
    const content =
      '---\ntitle: 第2章·客栈\nstatus: 完稿\ncustom: 保留我\n---\n\n客栈正文。\n### 场景甲';
    writeTree(work, { 'manuscript/第一卷/第2章·客栈.md': content }); // legacy 阿拉伯编号
    const res = renameChapter(work, 'manuscript/第一卷/第2章·客栈.md', '少年');
    expect(res).toEqual({ ok: true, relPath: 'manuscript/第一卷/第二章·少年.md' });
    expect(fs.readFileSync(path.join(work, 'manuscript/第一卷/第二章·少年.md'), 'utf8')).toBe(
      '---\ntitle: 第二章·少年\nstatus: 完稿\ncustom: 保留我\n---\n\n客栈正文。\n### 场景甲',
    );
    expect(fs.existsSync(path.join(work, 'manuscript/第一卷/第2章·客栈.md'))).toBe(false);
  });

  it('不匹配命名模式的文件直接用新标题', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/开篇.md': '---\ntitle: 开篇\n---\n引子正文。' });
    expect(renameChapter(work, 'manuscript/开篇.md', '楔子')).toEqual({
      ok: true,
      relPath: 'manuscript/楔子.md',
    });
    expect(fs.readFileSync(path.join(work, 'manuscript/楔子.md'), 'utf8')).toBe(
      '---\ntitle: 楔子\n---\n引子正文。',
    );
  });

  it('无 frontmatter 的文件改名时补建 fm 块', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章·旧.md': '只有正文。' }); // legacy 阿拉伯编号
    expect(renameChapter(work, 'manuscript/第1章·旧.md', '新').relPath).toBe(
      'manuscript/第一章·新.md',
    );
    expect(fs.readFileSync(path.join(work, 'manuscript/第一章·新.md'), 'utf8')).toBe(
      '---\ntitle: 第一章·新\n---\n只有正文。',
    );
  });

  it('目标同名已存在抛错；带编号前缀的 title 拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一章·少年.md': chapter('第一章·少年'),
      'manuscript/第一章·客栈.md': chapter('第一章·客栈'),
    });
    expect(() => renameChapter(work, 'manuscript/第一章·客栈.md', '少年')).toThrow(/已存在/);
    expect(() => renameChapter(work, 'manuscript/第一章·客栈.md', '第9章·客栈')).toThrow(/编号前缀/);
    expect(() => renameChapter(work, 'manuscript/第一章·客栈.md', 'a/b')).toThrow(/分隔符/);
  });
});

describe('rename_volume', () => {
  it('匹配卷名模式时保留编号只换标题；不匹配直接用新标题', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript/第2卷·客栈'), { recursive: true }); // legacy 阿拉伯编号
    expect(renameVolume(work, 'manuscript/第2卷·客栈', '风起')).toEqual({
      ok: true,
      volumePath: 'manuscript/第二卷·风起',
    });
    expect(fs.statSync(path.join(work, 'manuscript/第二卷·风起')).isDirectory()).toBe(true);

    // 汉字编号同样匹配模式 → 保留编号只换标题
    fs.mkdirSync(path.join(work, 'manuscript/第一卷·旧'), { recursive: true });
    expect(renameVolume(work, 'manuscript/第一卷·旧', '云涌').volumePath).toBe(
      'manuscript/第一卷·云涌',
    );
  });

  it('拒绝等于 manuscript 本身或非 manuscript/ 前缀；目标同名已存在抛错', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript/第一卷·风起'), { recursive: true });
    fs.mkdirSync(path.join(work, 'manuscript/第一卷·云涌'), { recursive: true });
    expect(() => renameVolume(work, 'manuscript', 'x')).toThrow();
    expect(() => renameVolume(work, 'notes', 'x')).toThrow();
    expect(() => renameVolume(work, 'manuscript/第一卷·风起', '云涌')).toThrow(/已存在/);
  });
});

describe('move_chapter', () => {
  it('重排后编号 1..N 连续、用户标题保留、fm title 同步', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷/第一章·少年.md': chapter('第一章·少年'),
      'manuscript/第一卷/第二章·客栈.md': chapter('第二章·客栈'),
      'manuscript/第一卷/第三章·风起.md': chapter('第三章·风起'),
    });
    const res = moveChapter(work, 'manuscript/第一卷/第三章·风起.md', 0);
    expect(res.ok).toBe(true);
    expect(res.renumbered.map((c) => c.title)).toEqual(['第一章·风起', '第二章·少年', '第三章·客栈']);
    expect(res.renumbered.map((c) => c.relPath)).toEqual([
      'manuscript/第一卷/第一章·风起.md',
      'manuscript/第一卷/第二章·少年.md',
      'manuscript/第一卷/第三章·客栈.md',
    ]);
    expect(fs.readFileSync(path.join(work, 'manuscript/第一卷/第一章·风起.md'), 'utf8')).toContain(
      'title: 第一章·风起',
    );
    expect(fs.readFileSync(path.join(work, 'manuscript/第一卷/第三章·客栈.md'), 'utf8')).toContain(
      'title: 第三章·客栈',
    );
    expect(fs.existsSync(path.join(work, 'manuscript/第一卷/第三章·风起.md'))).toBe(false);
  });

  it('移到同位置幂等：两次调用结果一致且不再改名', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷/第一章·少年.md': chapter('第一章·少年'),
      'manuscript/第一卷/第二章·客栈.md': chapter('第二章·客栈'),
    });
    const once = moveChapter(work, 'manuscript/第一卷/第一章·少年.md', 0);
    expect(once.renumbered.map((c) => c.title)).toEqual(['第一章·少年', '第二章·客栈']);
    const twice = moveChapter(work, 'manuscript/第一卷/第一章·少年.md', 0);
    expect(twice.renumbered).toEqual(once.renumbered);
    expect(sortedNames(fs.readdirSync(path.join(work, 'manuscript/第一卷')))).toEqual([
      '第一章·少年.md',
      '第二章·客栈.md',
    ]);
  });

  it('不匹配模式的旧章名不动，但排序仍按文件名', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷/第一章·少年.md': chapter('第一章·少年'),
      'manuscript/第一卷/旧稿·未编号.md': chapter('旧稿·未编号'),
    });
    const res = moveChapter(work, 'manuscript/第一卷/第一章·少年.md', 1);
    expect(res.renumbered.map((c) => c.title)).toEqual(['旧稿·未编号', '第二章·少年']);
    expect(fs.existsSync(path.join(work, 'manuscript/第一卷/旧稿·未编号.md'))).toBe(true);
  });

  it('不支持跨卷移动（toIndex 越界抛错）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷/第一章·少年.md': chapter('第一章·少年'),
      'manuscript/第一卷/第二章·客栈.md': chapter('第二章·客栈'),
      'manuscript/第二卷/第一章·风起.md': chapter('第一章·风起'),
    });
    expect(() => moveChapter(work, 'manuscript/第一卷/第一章·少年.md', 2)).toThrow(/跨卷/);
    expect(() => moveChapter(work, 'manuscript/第一卷/第一章·少年.md', -1)).toThrow();
    expect(() => moveChapter(work, 'manuscript/第一卷/没有.md', 0)).toThrow();
  });

  it('目标名冲突整体拒绝（不改任何文件）', () => {
    const work = makeWorkDir();
    const ch1 = chapter('第一章·少年');
    const ch2 = chapter('第二章·少年'); // 同用户标题：重排后目标名互相撞车
    writeTree(work, {
      'manuscript/第一卷/第一章·少年.md': ch1,
      'manuscript/第一卷/第二章·少年.md': ch2,
    });
    expect(() => moveChapter(work, 'manuscript/第一卷/第一章·少年.md', 1)).toThrow(/冲突/);
    expect(sortedNames(fs.readdirSync(path.join(work, 'manuscript/第一卷')))).toEqual([
      '第一章·少年.md',
      '第二章·少年.md',
    ]);
    expect(fs.readFileSync(path.join(work, 'manuscript/第一卷/第一章·少年.md'), 'utf8')).toBe(ch1);
    expect(fs.readFileSync(path.join(work, 'manuscript/第一卷/第二章·少年.md'), 'utf8')).toBe(ch2);
  });
});

describe('move_volume', () => {
  it('重排：卷名按最终顺序重编号 1..N', () => {
    const work = makeWorkDir();
    for (const v of ['第一卷·风起', '第二卷·云涌', '第三卷·雷动']) {
      fs.mkdirSync(path.join(work, 'manuscript', v), { recursive: true });
    }
    const res = moveVolume(work, 'manuscript/第三卷·雷动', 0);
    expect(res.ok).toBe(true);
    expect(res.renumbered.map((v) => v.title)).toEqual(['第一卷·雷动', '第二卷·风起', '第三卷·云涌']);
    expect(res.renumbered.map((v) => v.volumePath)).toEqual([
      'manuscript/第一卷·雷动',
      'manuscript/第二卷·风起',
      'manuscript/第三卷·云涌',
    ]);
    expect(sortedNames(fs.readdirSync(path.join(work, 'manuscript')))).toEqual([
      '第一卷·雷动',
      '第二卷·风起',
      '第三卷·云涌',
    ]);
  });

  it('未匹配卷名的目录不改名但参与排序', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript/第一卷·风起'), { recursive: true });
    fs.mkdirSync(path.join(work, 'manuscript/杂集'), { recursive: true });
    const res = moveVolume(work, 'manuscript/第一卷·风起', 1);
    expect(res.renumbered.map((v) => v.title)).toEqual(['杂集', '第二卷·风起']);
    expect(sortedNames(fs.readdirSync(path.join(work, 'manuscript')))).toEqual(['杂集', '第二卷·风起']);
  });

  it('目标名冲突整体拒绝；toIndex 越界抛错', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript/第一卷·风起'), { recursive: true });
    fs.mkdirSync(path.join(work, 'manuscript/第二卷·风起'), { recursive: true });
    expect(() => moveVolume(work, 'manuscript/第一卷·风起', 1)).toThrow(/冲突/);
    expect(() => moveVolume(work, 'manuscript/第一卷·风起', 5)).toThrow(/越界/);
    expect(sortedNames(fs.readdirSync(path.join(work, 'manuscript')))).toEqual(['第一卷·风起', '第二卷·风起']);
  });
});
