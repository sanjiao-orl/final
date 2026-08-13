// approval.svelte.ts 单测：B6 分级审批门——ask/auto/yolo 三种模式、会话放行表、挂起去重。
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalGate, DANGEROUS_TOOLS, describeDangerous } from './approval.svelte.js';

function gate(): ApprovalGate {
  return new ApprovalGate();
}

beforeEach(() => {
  // ApprovalGate 是纯实例，无共享状态
});

describe('ApprovalGate', () => {
  it('危险工具集：写/删/导出；目标键按工具派生', () => {
    expect([...DANGEROUS_TOOLS].sort()).toEqual(['delete_chapter', 'export_txt', 'write_chapter']);
    expect(describeDangerous('write_chapter', { relPath: 'manuscript/a.md' })).toEqual({
      target: 'manuscript/a.md',
      targetKey: 'write:manuscript/a.md',
    });
    expect(describeDangerous('export_txt', {})).toEqual({ target: '全稿导出 txt', targetKey: 'export' });
  });

  it('非危险工具一律放行，不挂卡', () => {
    const g = gate();
    expect(g.decide('c1', 'read_chapter', { relPath: 'x.md' }, 'ask')).toBe('allow');
    expect(g.pending).toEqual([]);
  });

  it('ask 模式：危险工具挂起并弹卡；同目标重复调用只挂一条', () => {
    const g = gate();
    expect(g.decide('c1', 'write_chapter', { relPath: 'manuscript/a.md' }, 'ask')).toBe('pending');
    expect(g.decide('c2', 'write_chapter', { relPath: 'manuscript/a.md' }, 'ask')).toBe('pending');
    expect(g.pending).toHaveLength(1);
    expect(g.active?.callId).toBe('c1');
  });

  it('auto 模式：未放行挂起；允许本会话后同类同目标直放，换目标仍询问', () => {
    const g = gate();
    expect(g.decide('c1', 'write_chapter', { relPath: 'manuscript/a.md' }, 'auto')).toBe('pending');
    g.resolve('c1', 'session');
    expect(g.pending).toEqual([]);
    expect(g.active).toBeNull();
    expect(g.decide('c2', 'write_chapter', { relPath: 'manuscript/a.md' }, 'auto')).toBe('allow');
    expect(g.decide('c3', 'write_chapter', { relPath: 'manuscript/b.md' }, 'auto')).toBe('pending');
  });

  it('允许一次：不放行表，下一次同类仍询问', () => {
    const g = gate();
    g.decide('c1', 'delete_chapter', { relPath: 'manuscript/a.md' }, 'auto');
    g.resolve('c1', 'once');
    expect(g.decide('c2', 'delete_chapter', { relPath: 'manuscript/a.md' }, 'auto')).toBe('pending');
  });

  it('yolo 模式：危险工具全部自动放行', () => {
    const g = gate();
    expect(g.decide('c1', 'write_chapter', { relPath: 'manuscript/a.md' }, 'yolo')).toBe('allow');
    expect(g.pending).toEqual([]);
  });

  it('拒绝：移出挂起并推进到下一张卡', () => {
    const g = gate();
    g.decide('c1', 'write_chapter', { relPath: 'manuscript/a.md' }, 'ask');
    g.decide('c2', 'export_txt', {}, 'ask');
    g.resolve('c1', 'reject');
    expect(g.pending).toHaveLength(1);
    expect(g.active?.callId).toBe('c2');
    g.resolve('c2', 'reject');
    expect(g.pending).toEqual([]);
    expect(g.active).toBeNull();
  });

  it('resetSessionAllowed：清掉本会话放行表，session/auto 下同目标再询问', () => {
    const g = gate();
    g.decide('c1', 'write_chapter', { relPath: 'manuscript/a.md' }, 'auto');
    g.resolve('c1', 'session');
    expect(g.decide('c2', 'write_chapter', { relPath: 'manuscript/a.md' }, 'auto')).toBe('allow');
    g.resetSessionAllowed();
    expect(g.decide('c3', 'write_chapter', { relPath: 'manuscript/a.md' }, 'auto')).toBe('pending');
  });
});
