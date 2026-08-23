// @vitest-environment jsdom
// 测试：markdown ↔ 编辑器 HTML 桥——场景 ###、中文引号、段落空行的往返稳定（mdToHtml 已过净化，需 DOM）。
import { describe, expect, it } from 'vitest';
import { htmlToMd, isBlankHtml, mdToHtml } from './markdown.js';

const BODY = '清晨的雾气笼罩着青崖山，石阶上的露水还没干。\n\n### 临行\n\n"此去山下，凡事看清楚了再动手。"师父说。\n\n林渡捏着铜钱，觉得分量不对——比寻常铜钱沉了几乎一倍。\n';

describe('mdToHtml', () => {
  it('段落 → p，### → h3', () => {
    const html = mdToHtml(BODY);
    expect(html).toContain('<p>清晨的雾气笼罩着青崖山，石阶上的露水还没干。</p>');
    expect(html).toContain('<h3>临行</h3>');
  });

  it('AI 采纳正文混入恶意 raw HTML：净化后再进编辑器（评审 D12 提前项）', () => {
    const html = mdToHtml('正文。\n\n<img src=x onerror=alert(1)><script>steal()</script>\n\n尾。');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('正文。');
  });
});

describe('htmlToMd', () => {
  it('p/h3 还原为空行分隔与 ###，收尾恰好一个换行', () => {
    const md = htmlToMd('<p>第一段。</p><h3>临行</h3><p>第二段。</p>');
    expect(md).toBe('第一段。\n\n### 临行\n\n第二段。\n');
  });
});

describe('往返', () => {
  it('正文 md → html → md 内容稳定（中文标点不动）', () => {
    const once = htmlToMd(mdToHtml(BODY));
    expect(once).toBe(BODY);
    // 二次往返幂等
    expect(htmlToMd(mdToHtml(once))).toBe(once);
  });

  it('围栏代码块内连续空行不被折叠（真相永远在正文文件）', () => {
    const body = '正文第一段。\n\n```\n甲\n\n\n乙\n```\n\n正文第二段。\n';
    const once = htmlToMd(mdToHtml(body));
    expect(once).toContain('```\n甲\n\n\n乙\n```'); // 块内两个连续空行逐字节保留
    // 二次往返仍稳定
    expect(htmlToMd(mdToHtml(once))).toBe(once);
  });

  it('围栏代码块外的连续空行照常折叠为单空行', () => {
    const md = htmlToMd('<p>第一段。</p><p>第二段。</p><p>第三段。</p>');
    expect(md).toBe('第一段。\n\n第二段。\n\n第三段。\n');
  });

  it('4 空格缩进代码块开头的章：首打开保存后内容不丢（转为围栏形式）', () => {
    const body = '    甲\n    乙\n\n正文。\n';
    const once = htmlToMd(mdToHtml(body));
    expect(once).toContain('甲'); // 代码内容保留
    expect(once).toContain('乙');
    expect(once).toContain('```'); // 仍是代码块（缩进 → 围栏，内容等价）
  });
});

describe('isBlankHtml', () => {
  it('空段落视为空，有内容不视为空', () => {
    expect(isBlankHtml('<p></p>')).toBe(true);
    expect(isBlankHtml('<p>字</p>')).toBe(false);
  });
});
