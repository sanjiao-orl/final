/**
 * frontmatter.test.ts —— 简单 YAML 子集解析：全字段、tags 两种写法、缺失/残缺容忍。
 */
import { describe, expect, it } from 'vitest';
import { frontmatterEnd, parseFrontmatter } from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('解析全部字段（tags 为数组）', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'title: 第一章',
        'status: 完稿',
        'pov: 主角',
        'tags: [开局, 夜]',
        'synopsis: 这一章讲什么。',
        '---',
        '正文。',
      ].join('\n'),
    );
    expect(fm).toEqual({
      title: '第一章',
      status: '完稿',
      pov: '主角',
      tags: ['开局', '夜'],
      synopsis: '这一章讲什么。',
    });
  });

  it('tags 支持逗号分隔字符串写法', () => {
    expect(parseFrontmatter('---\ntags: 开局, 夜\n---\n正文').tags).toBe('开局, 夜');
  });

  it('未知字段忽略、空字符串字段省略', () => {
    const fm = parseFrontmatter('---\ntitle: 有题\nstatus: \nother: 123\n---\n正文');
    expect(fm).toEqual({ title: '有题' });
  });

  it('残缺 YAML 容忍为空对象', () => {
    expect(parseFrontmatter('---\ntitle: [未闭合\n---\n正文')).toEqual({});
    expect(parseFrontmatter('---\n')).toEqual({});
  });

  it('无 frontmatter 返回空对象', () => {
    expect(parseFrontmatter('纯正文没有元数据。')).toEqual({});
    expect(parseFrontmatter('')).toEqual({});
  });

  it('正文中出现的 --- 行不会误判为 frontmatter 闭合', () => {
    // 首个独立 --- 闭合后即正文；正文里的 --- 不影响解析
    const content = '---\ntitle: 一\n---\n正文\n---\n还是正文';
    expect(parseFrontmatter(content).title).toBe('一');
    expect(frontmatterEnd(content)).toBe('---\ntitle: 一\n---\n'.length);
  });

  it('frontmatterEnd 返回正文起始偏移', () => {
    expect(frontmatterEnd('---\ntitle: 一\n---\n正文')).toBe('---\ntitle: 一\n---\n'.length);
    expect(frontmatterEnd('没有元数据')).toBe(0);
  });

  it('解析 id 与 goal（number 取整数、字符串数字才收、非法忽略）', () => {
    // 字符串数字：能 parseInt 成正整数才收
    const fm = parseFrontmatter('---\nid: ch-0001\ngoal: "3000"\n---\n正文。');
    expect(fm.id).toBe('ch-0001');
    expect(fm.goal).toBe(3000);
    // number 直接收，取整数
    expect(parseFrontmatter('---\ngoal: 2500\n---\n正文').goal).toBe(2500);
    expect(parseFrontmatter('---\ngoal: 2500.8\n---\n正文').goal).toBe(2500);
    // 非法/非正整数忽略
    expect(parseFrontmatter('---\ngoal: 不是数字\n---\n正文').goal).toBeUndefined();
    expect(parseFrontmatter('---\ngoal: "-3"\n---\n正文').goal).toBeUndefined();
    expect(parseFrontmatter('---\ngoal: "0"\n---\n正文').goal).toBeUndefined();
    // 空 id 不收
    expect(parseFrontmatter('---\nid: \n---\n正文').id).toBeUndefined();
    // 缺省不出现
    expect(parseFrontmatter('---\ntitle: 一\n---\n正文').id).toBeUndefined();
    expect(parseFrontmatter('---\ntitle: 一\n---\n正文').goal).toBeUndefined();
  });
});
