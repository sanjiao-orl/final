// frontmatter.ts 单测（任务 2a/2b）：status 行改写/插入/空块生成/字节级保留 + 三态回环判定。
import { describe, expect, it } from 'vitest';
import { nextChapterStatus, setFrontmatterStatus } from './frontmatter.js';

describe('setFrontmatterStatus', () => {
  it('已有 status 行：只改值，其余键与换行字节级保留', () => {
    const raw = '---\ntitle: 第一章\ntags: [a, b]\nstatus: 草稿\nid: abc-123\n---\n';
    expect(setFrontmatterStatus(raw, '已发布')).toBe(
      '---\ntitle: 第一章\ntags: [a, b]\nstatus: 已发布\nid: abc-123\n---\n',
    );
  });

  it('status 在末行且无尾换行：照常改值不补换行', () => {
    expect(setFrontmatterStatus('---\nstatus: 草稿', '已校对')).toBe('---\nstatus: 已校对');
  });

  it('status 旧值整行替换（连行尾内容），其他行原样', () => {
    const raw = '---\nstatus: 待定  # 备注\n---\n';
    expect(setFrontmatterStatus(raw, '已发布')).toBe('---\nstatus: 已发布\n---\n');
  });

  it('CRLF 行尾保留：\r\n 不被吃掉', () => {
    const raw = '---\r\nstatus: 草稿\r\ntitle: A\r\n---\r\n';
    expect(setFrontmatterStatus(raw, '已发布')).toBe('---\r\nstatus: 已发布\r\ntitle: A\r\n---\r\n');
  });

  it('有 fm 无 status 行：插入开栏 --- 之后，其余键不动', () => {
    const raw = '---\ntitle: 第一章\ngoal: 2000\n---\n';
    expect(setFrontmatterStatus(raw, '草稿')).toBe('---\nstatus: 草稿\ntitle: 第一章\ngoal: 2000\n---\n');
  });

  it('空 fmRaw：造最小块（---\\nstatus: v\\n---\\n\\n）', () => {
    expect(setFrontmatterStatus('', '草稿')).toBe('---\nstatus: 草稿\n---\n\n');
  });

  it('改写幂等：同值重复设置结果不变', () => {
    const raw = '---\nstatus: 草稿\n---\n';
    expect(setFrontmatterStatus(setFrontmatterStatus(raw, '草稿'), '草稿')).toBe(raw);
  });
});

describe('nextChapterStatus · 三态回环（任务 2b 纯判定）', () => {
  it('无 status / 空串 / 未知值 → 草稿', () => {
    expect(nextChapterStatus(undefined)).toBe('草稿');
    expect(nextChapterStatus('')).toBe('草稿');
    expect(nextChapterStatus('完结')).toBe('草稿');
  });

  it('草稿 → 已发布 → 已校对 → 草稿（回环）', () => {
    expect(nextChapterStatus('草稿')).toBe('已发布');
    expect(nextChapterStatus('已发布')).toBe('已校对');
    expect(nextChapterStatus('已校对')).toBe('草稿');
  });
});
