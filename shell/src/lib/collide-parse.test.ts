// collide-parse.ts 单测：碰撞模式的四节结构化解析（容错：不齐/乱序/陌生 h2 → null 回退整泡）。
import { describe, expect, it } from 'vitest';
import { collideParse } from './collide-parse.js';

describe('collideParse', () => {
  it('四节齐备且按序 → 拆分 4 段，sec/md 正确', () => {
    const content = [
      '## 方案',
      'A 方案，配 3-4-3 结构。',
      '## 漏洞',
      '- 风险一',
      '- 风险二',
      '## 反方',
      '反方意见。',
      '## 裁决',
      '综上，采纳 A。',
    ].join('\n');
    const out = collideParse(content);
    expect(out).not.toBeNull();
    expect(out!.map((s) => s.sec)).toEqual(['方案', '漏洞', '反方', '裁决']);
    expect(out![0]!.md).toBe('## 方案\nA 方案，配 3-4-3 结构。');
    expect(out![1]!.md).toBe('## 漏洞\n- 风险一\n- 风险二');
    expect(out![2]!.md).toBe('## 反方\n反方意见。');
    expect(out![3]!.md).toBe('## 裁决\n综上，采纳 A。');
  });

  it('标题前的引导内容并入第一段 md 开头', () => {
    const content = [
      '以下是本次碰撞的交锋结果：',
      '',
      '## 方案',
      'A 方案。',
      '## 漏洞',
      '有缺陷。',
      '## 反方',
      '反对。',
      '## 裁决',
      '准。',
    ].join('\n');
    const out = collideParse(content);
    expect(out).not.toBeNull();
    expect(out![0]!.md).toBe('以下是本次碰撞的交锋结果：\n\n## 方案\nA 方案。');
    expect(out!.length).toBe(4);
  });

  it('缺任一标题 → null', () => {
    const content = ['## 方案', 'A。', '## 漏洞', 'B。', '## 反方', 'C。'].join('\n'); // 缺裁决
    expect(collideParse(content)).toBeNull();
  });

  it('四节顺序错乱 → null', () => {
    const content = ['## 漏洞', 'x', '## 方案', 'y', '## 反方', 'z', '## 裁决', 'w'].join('\n');
    expect(collideParse(content)).toBeNull();
  });

  it('含额外 h2 标题（四节之外）→ null', () => {
    const content = [
      '## 方案',
      'A。',
      '## 简介',
      '多余的一节。',
      '## 漏洞',
      'B。',
      '## 反方',
      'C。',
      '## 裁决',
      'D。',
    ].join('\n');
    expect(collideParse(content)).toBeNull();
  });

  it('节内含 h3/列表/代码块 → 正常拆段', () => {
    const content = [
      '## 方案',
      '### 步骤',
      '1. 甲',
      '```js',
      'const a = 1;',
      '```',
      '## 漏洞',
      '没有。',
      '## 反方',
      '有异议。',
      '## 裁决',
      '维持。',
    ].join('\n');
    const out = collideParse(content);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(4);
    expect(out![0]!.md).toContain('### 步骤');
    expect(out![0]!.md).toContain('```js');
  });

  it('空串 / 纯空白 → null', () => {
    expect(collideParse('')).toBeNull();
    expect(collideParse('   \n  ')).toBeNull();
  });

  it('普通消息（无四节）→ null', () => {
    expect(collideParse('就是一个普通的回答，没有结构。')).toBeNull();
  });

  it('标题行首尾空格容忍（`##  方案 `）', () => {
    const content = [
      '##  方案 ',
      'A。',
      '## 漏洞',
      'B。',
      '## 反方',
      'C。',
      '## 裁决',
      'D。',
    ].join('\n');
    const out = collideParse(content);
    expect(out).not.toBeNull();
    expect(out![0]!.sec).toBe('方案');
  });
});
