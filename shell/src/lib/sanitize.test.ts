// @vitest-environment jsdom
// 测试：LLM 输出净化（DOMPurify 白名单）——恶意标记剥除、合法 GFM 产物保留。
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { sanitizeHtml } from './sanitize.js';

describe('sanitizeHtml 恶意标记剥除', () => {
  it('script/iframe 整体剥除', () => {
    expect(sanitizeHtml('<p>正文</p><script>alert(1)</script>')).toBe('<p>正文</p>');
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>')).toBe('');
  });

  it('事件属性剥除（onerror/onload/onclick）', () => {
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).not.toContain('onerror');
    expect(sanitizeHtml('<p onclick="alert(1)">字</p>')).toBe('<p>字</p>');
  });

  it('javascript: 链接净化', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
    expect(out).toContain('点我');
    expect(out).not.toContain('javascript:');
  });

  it('style 标签剥除（防全应用样式注入）', () => {
    expect(sanitizeHtml('<style>body{display:none}</style><p>字</p>')).toBe('<p>字</p>');
  });
});

describe('sanitizeHtml 合法 GFM 产物保留（marked 输出不被净化回退）', () => {
  it('表格/代码块/删除线/链接/任务列表原样通过', () => {
    const md = [
      '| 甲 | 乙 |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```\n<不是标签>\n```',
      '',
      '~~删除~~ [链接](https://example.com)',
      '',
      '- [x] 已完成',
      '- [ ] 未完成',
    ].join('\n');
    const html = marked.parse(md, { async: false, gfm: true }) as string;
    const out = sanitizeHtml(html);
    expect(out).toContain('<table>');
    expect(out).toContain('<del>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('<input');
    expect(out).toContain('&lt;不是标签&gt;'); // 代码块内实体保留，不被当标签解析
  });

  it('img data: URI 保留（CSP 允许）', () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="图">')).toContain('src="data:image/png');
  });
});

describe('marked→sanitize 端到端（raw HTML 混入 md）', () => {
  it('LLM 输出里的 raw HTML 块被净化', () => {
    const md = '正文段。\n\n<img src=x onerror=alert(1)>\n\n尾段。';
    const html = sanitizeHtml(marked.parse(md, { async: false, gfm: true }) as string);
    expect(html).toContain('正文段。');
    expect(html).not.toContain('onerror');
  });
});
