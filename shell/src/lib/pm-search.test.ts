// 测试：pm-search 纯文本定位——拼接约定、跨段搜索、偏移→PM 位置映射（round-trip 性质）、歧义/未命中。
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PMNode } from '@tiptap/pm/model';
import { captureSelection, docText, findTextRanges, locateUnique } from './pm-search.js';

const schema = getSchema([StarterKit]);

function doc(json: object): PMNode {
  return schema.nodeFromJSON(json);
}

const SAMPLE = doc({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '清晨的雾气笼罩着青崖山。' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '临行' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '林渡捏着铜钱，觉得分量不对。' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '他没有声张。' }] },
  ],
});

describe('docText', () => {
  it('块间恰好一个换行，段落与标题一视同仁', () => {
    expect(docText(SAMPLE)).toBe('清晨的雾气笼罩着青崖山。\n临行\n林渡捏着铜钱，觉得分量不对。\n他没有声张。');
  });

  it('hard_break 渲染为换行', () => {
    const d = doc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '甲' }, { type: 'hardBreak' }, { type: 'text', text: '乙' }],
        },
      ],
    });
    expect(docText(d)).toBe('甲\n乙');
  });
});

describe('findTextRanges', () => {
  it('段内命中：范围 round-trip 回原文，首段起始位置正确', () => {
    const ranges = findTextRanges(SAMPLE, '雾气');
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ from: 4, to: 6 }); // 段首 pos=1，'清晨的' 3 字后
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe('雾气');
  });

  it('跨块命中（段落→标题）：round-trip 回原文', () => {
    const needle = '青崖山。\n临行';
    const ranges = findTextRanges(SAMPLE, needle);
    expect(ranges).toHaveLength(1);
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe(needle);
  });

  it('跨多块命中（含两个块间隙）', () => {
    const needle = '临行\n林渡捏着铜钱，觉得分量不对。\n他没有声张。';
    const ranges = findTextRanges(SAMPLE, needle);
    expect(ranges).toHaveLength(1);
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe(needle);
  });

  it('整文档 needle：from=1，to=文末', () => {
    const whole = docText(SAMPLE);
    const ranges = findTextRanges(SAMPLE, whole);
    expect(ranges).toHaveLength(1);
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe(whole);
  });

  it('重复文本返回多个命中；不存在返回空', () => {
    const d = doc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '他笑了。' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '他笑了。' }] },
      ],
    });
    expect(findTextRanges(d, '他笑了。')).toHaveLength(2);
    expect(findTextRanges(d, '不存在的话')).toEqual([]);
  });

  it('hard_break 文档：跨硬换行命中', () => {
    const d = doc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '甲' }, { type: 'hardBreak' }, { type: 'text', text: '乙' }],
        },
      ],
    });
    const ranges = findTextRanges(d, '甲\n乙');
    expect(ranges).toHaveLength(1);
    expect(captureSelection(d, ranges[0]!.from, ranges[0]!.to)).toBe('甲\n乙');
  });

  it('跨 hr（块级 leaf）：选区捕获与 docText 同约定，可唯一回找', () => {
    const d = doc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '甲段' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: '乙段' }] },
      ],
    });
    const needle = '甲段\n乙段';
    expect(docText(d)).toBe(needle); // hr 不进入扁平文本
    const ranges = findTextRanges(d, needle);
    expect(ranges).toHaveLength(1);
    expect(captureSelection(d, ranges[0]!.from, ranges[0]!.to)).toBe(needle);
    expect(locateUnique(d, needle)).toEqual({ ok: true, range: ranges[0] });
  });
});

describe('findTextRanges 紧凑兜底（D7 跨行 quote 定位）', () => {
  it('段间空行 needle（源文件式 \\n\\n 摘录）：紧凑命中，范围 round-trip 回文档约定文本', () => {
    const needle = '青崖山。\n\n临行'; // 源 md 段间空行，拼接串块间只有一个 \n——精确必失配
    const ranges = findTextRanges(SAMPLE, needle);
    expect(ranges).toHaveLength(1);
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe('青崖山。\n临行');
  });

  it('CRLF needle（\\r\\n 摘录）：紧凑命中', () => {
    const ranges = findTextRanges(SAMPLE, '青崖山。\r\n临行');
    expect(ranges).toHaveLength(1);
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe('青崖山。\n临行');
  });

  it('全空白 needle 紧凑后为空串：不兜底，返回空', () => {
    expect(findTextRanges(SAMPLE, ' \n\u3000\r\n')).toEqual([]);
  });

  it('多段锚（replace 候选 original 跨段原必 not-found）：locateUnique 紧凑兜底后唯一命中', () => {
    const r = locateUnique(SAMPLE, '林渡捏着铜钱，觉得分量不对。\n\n他没有声张。');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(captureSelection(SAMPLE, r.range.from, r.range.to)).toBe('林渡捏着铜钱，觉得分量不对。\n他没有声张。');
    }
  });

  it('紧凑仍找不到（内容不存在）→ 空', () => {
    expect(findTextRanges(SAMPLE, '不存在的句子\n\n另一段也没有')).toEqual([]);
  });

  it('精确命中优先：单 \n 跨块 needle 不受兜底影响（行为回归保护）', () => {
    const needle = '青崖山。\n临行';
    const ranges = findTextRanges(SAMPLE, needle);
    expect(ranges).toHaveLength(1);
    expect(captureSelection(SAMPLE, ranges[0]!.from, ranges[0]!.to)).toBe(needle);
  });
});

describe('locateUnique', () => {
  it('唯一命中 ok；零命中 not-found；多命中 ambiguous', () => {
    expect(locateUnique(SAMPLE, '临行')).toEqual({ ok: true, range: findTextRanges(SAMPLE, '临行')[0] });
    expect(locateUnique(SAMPLE, '没有这句')).toEqual({ ok: false, reason: 'not-found' });
    const dup = doc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '同上。' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '同上。' }] },
      ],
    });
    expect(locateUnique(dup, '同上。')).toEqual({ ok: false, reason: 'ambiguous' });
  });
});
