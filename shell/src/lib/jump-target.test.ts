// jump-target.ts 单测（T9 A 半区）：行号口径换算（文件行 ↔ 正文行）与 PM 块位估算纯函数。
import { describe, expect, it } from 'vitest';
import {
  bodyLineForFileLine,
  estimateBlockIndex,
  frontmatterLineCount,
  targetLineText,
} from './jump-target.js';

describe('frontmatterLineCount', () => {
  it('空串 → 0（无 frontmatter）', () => {
    expect(frontmatterLineCount('')).toBe(0);
  });

  it('以换行结尾的 fm 文本块：行数 = split.length - 1', () => {
    expect(frontmatterLineCount('---\ntitle: 第一章\n---\n')).toBe(3);
    expect(frontmatterLineCount('---\r\ntitle: 第一章\r\n---\r\n')).toBe(3); // CRLF 同口径
  });

  it('无尾换行：末行后无换行符不计数（split.length - 1 口径）', () => {
    expect(frontmatterLineCount('---\ntitle: 第一章\n---')).toBe(2);
  });
});

describe('bodyLineForFileLine', () => {
  const fm = '---\ntitle: 第一章\n---\n'; // 3 行

  it('正常换算：fileLine - fm 行数', () => {
    expect(bodyLineForFileLine(4, fm)).toBe(1); // 文件第 4 行 = 正文第 1 行
    expect(bodyLineForFileLine(10, fm)).toBe(7);
  });

  it('落在 frontmatter 内 / 边界 → null', () => {
    expect(bodyLineForFileLine(3, fm)).toBeNull(); // 恰是 fm 末行
    expect(bodyLineForFileLine(0, '')).toBeNull();
  });
});

describe('targetLineText', () => {
  const md = '# 场景一\n\n第一段正文。\n\n\n第二段正文。';

  it('正常行：剥掉标题前缀后 trim 返回', () => {
    expect(targetLineText(md, 1)).toBe('场景一');
    expect(targetLineText(md, 3)).toBe('第一段正文。');
    expect(targetLineText('### 三级标题\n正文', 1)).toBe('三级标题'); // ### 也剥
  });

  it('空白行向上贴最近非空行', () => {
    expect(targetLineText(md, 2)).toBe('场景一'); // 第 2 行空 → 贴标题行
    expect(targetLineText(md, 4)).toBe('第一段正文。'); // 第 4 行空 → 贴上一非空行
    expect(targetLineText(md, 6)).toBe('第二段正文。');
  });

  it('越界 → null；到顶仍全空 → null', () => {
    expect(targetLineText(md, 99)).toBeNull();
    expect(targetLineText(md, 0)).toBeNull();
    expect(targetLineText('\n\n  \n', 2)).toBeNull();
    expect(targetLineText('', 1)).toBeNull();
  });
});

describe('estimateBlockIndex', () => {
  it('首行 → 0', () => {
    expect(estimateBlockIndex('第一段。\n第二段。', 1)).toBe(0);
  });

  it('空行跳过不计入非空行序列', () => {
    // 非空行序列 = [第一段, 第二段, 第三段]；第三段之前有 2 个非空行
    expect(estimateBlockIndex('第一段。\n\n第二段。\n\n第三段。', 5)).toBe(2);
  });

  it('空白行贴靠后按下标取数：第 2 行空贴到第 1 行 → 0', () => {
    expect(estimateBlockIndex('# 标题\n\n第一段。', 2)).toBe(0);
  });

  it('无有效行 → -1（全空 / 越界 / 行号 < 1）', () => {
    expect(estimateBlockIndex('\n\n', 1)).toBe(-1);
    expect(estimateBlockIndex('第一段。', 99)).toBe(-1);
    expect(estimateBlockIndex('第一段。', 0)).toBe(-1);
  });
});
