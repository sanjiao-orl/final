/**
 * list_structure.test.ts —— 结构树：卷/章/场派生、标题优先级、空作品。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listStructure } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 第一章：frontmatter 带 title/status/tags，正文含 H1 与两个 ### 场景。 */
const CH1 = [
  '---',
  'title: 第一章 序曲',
  'status: 草稿',
  'tags: [开局, 夜]',
  '---',
  '',
  '# 总纲',
  '',
  '正文开头。',
  '### 夜雨',
  '第一场内容。',
  '### 相遇',
  '第二场内容。',
].join('\n');

/** 第二章：无 frontmatter，标题取自首个 H1。 */
const CH2 = ['# 第二章 无题', '没有 frontmatter 的章。', '### 场景甲'].join('\n');

describe('list_structure', () => {
  it('从文件内容派生出卷/章/场树', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': CH1,
      'manuscript/卷一/第二章.md': CH2,
      'manuscript/卷二/第三章.md': '无题无 H1\n### 独场',
      'manuscript/开篇.md': '---\ntitle: 开篇\n---\n### 引子',
      'manuscript/卷二/子目录/第四章.md': '### 深层场', // 深层文件归入“卷二”
      'manuscript/卷一/备注.txt': '不是 md，忽略',
    });

    const tree = listStructure(work);
    expect(tree.map((v) => v.title)).toEqual(['卷一', '卷二', '未分卷']);

    const vol1 = tree[0]!;
    expect(vol1.type).toBe('volume');
    expect(vol1.children.map((c) => c.title)).toEqual(['第一章 序曲', '第二章 无题']);

    // 章标题优先级：frontmatter.title > 首个 H1
    expect(vol1.children[0]!.title).toBe('第一章 序曲');
    expect(vol1.children[0]!.status).toBe('草稿');
    expect(vol1.children[1]!.title).toBe('第二章 无题');
    expect(vol1.children[1]!.status).toBeUndefined();

    // 场：### 标题 + 1 起始行号
    expect(vol1.children[0]!.scenes).toEqual([
      { type: 'scene', title: '夜雨', line: 10 },
      { type: 'scene', title: '相遇', line: 12 },
    ]);
    expect(vol1.children[1]!.scenes).toEqual([{ type: 'scene', title: '场景甲', line: 3 }]);

    // 无 frontmatter 无 H1：标题回退文件名
    const vol2 = tree[1]!;
    expect(vol2.children.map((c) => c.title)).toEqual(['第三章', '第四章']);
    expect(vol2.children[1]!.scenes).toEqual([{ type: 'scene', title: '深层场', line: 1 }]);

    // 散章归入“未分卷”
    const loose = tree[2]!;
    expect(loose.children).toHaveLength(1);
    expect(loose.children[0]!.title).toBe('开篇');

    // relPath 相对 workDir、正斜杠
    expect(vol1.children[0]!.relPath).toBe('manuscript/卷一/第一章.md');

    // 字数：正文非空白字符数（不含 frontmatter）
    expect(vol1.children[0]!.wordCount).toBe(30);
    expect(vol1.children[1]!.wordCount).toBe(28);
  });

  it('无 manuscript 目录返回空树', () => {
    expect(listStructure(makeWorkDir())).toEqual([]);
  });

  it('frontmatter 的 id/goal 透出到 ChapterNode（缺省不出现）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': '---\ntitle: 第一章\nid: ch-0001\ngoal: 5000\n---\n### 场甲',
      'manuscript/卷一/第二章.md': '---\ntitle: 第二章\n---\n### 场乙',
    });
    const [ch1, ch2] = listStructure(work)[0]!.children;
    expect(ch1!.id).toBe('ch-0001');
    expect(ch1!.goal).toBe(5000);
    expect(ch2!.id).toBeUndefined();
    expect(ch2!.goal).toBeUndefined();
  });

  it('空 manuscript 目录返回空树', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript'));
    expect(listStructure(work)).toEqual([]);
  });
});
