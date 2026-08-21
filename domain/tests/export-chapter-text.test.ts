import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportChapterText, exportTxt } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

describe('exportChapterText', () => {
  it('单章格式与全稿一致，并剥离场景标记与 frontmatter', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷/第一章.md': ['---', 'title: 第一章·序', 'status: 草稿', '---', '', '开头。', '', '### 场景一', '', '正文。'].join('\n'),
      'manuscript/第一卷/第二章.md': '---\ntitle: 第二章\n---\n\n第二章正文。',
    });
    const result = exportChapterText(work, 'manuscript/第一卷/第一章.md');
    const full = fs.readFileSync(path.join(work, exportTxt(work).path), 'utf8');
    expect(full).toContain(result.text);
    expect(result.text).toBe('第一章·序\n\n开头。\n\n场景一\n\n正文。');
    expect(result.text).not.toContain('---');
    expect(result.text).not.toContain('###');
  });

  it('拒绝非 manuscript 路径并报告不存在文件', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/not-chapter.md': 'x' });
    expect(() => exportChapterText(work, '.novel/not-chapter.md')).toThrow(/只允许 manuscript/);
    expect(() => exportChapterText(work, 'manuscript/不存在.md')).toThrow(/找不到对应章|不存在/);
  });
});

it('文件不存在时报告中文错误', () => {
  const work = makeWorkDir();
  expect(() => exportChapterText(work, 'manuscript/不存在.md')).toThrow(/不存在|找不到/);
});
