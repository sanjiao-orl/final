// theme.ts statusVar 单测（任务 2d）：三态互不同色、未知值回落默认色、深浅主题 token 俱在且互异。
import { describe, expect, it } from 'vitest';
import { palette, statusVar } from './theme.js';

describe('statusVar · 发布状态三态配色', () => {
  it('草稿/已发布/已校对 → 三个互不相同的状态变量', () => {
    const draft = statusVar('草稿');
    const published = statusVar('已发布');
    const proofread = statusVar('已校对');
    expect(draft).toBe('var(--status-draft)');
    expect(published).toBe('var(--status-polish)');
    expect(proofread).toBe('var(--status-final)');
    expect(new Set([draft, published, proofread]).size).toBe(3);
  });

  it('未知值 / 空串 / undefined → 回落默认 muted', () => {
    expect(statusVar('完结')).toBe('var(--muted)');
    expect(statusVar('')).toBe('var(--muted)');
    expect(statusVar(undefined)).toBe('var(--muted)');
  });

  it('三态色均不与回落色撞车（未知态在树/章头可区分）', () => {
    for (const s of ['草稿', '已发布', '已校对']) {
      expect(statusVar(s)).not.toBe(statusVar('未知'));
    }
  });

  it('深浅主题的 draft/polish/final 三色各自互异（statusVar 引用的 token 实值不同色）', () => {
    for (const mode of ['light', 'dark'] as const) {
      const p = palette[mode];
      expect(new Set([p.statusDraft, p.statusPolish, p.statusFinal]).size).toBe(3);
    }
  });
});
