import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    setScope: vi.fn(async () => { calls.push('setScope'); }),
    showCol: vi.fn(() => { calls.push('showCol'); }),
    setDraft: vi.fn(() => { calls.push('setDraft'); }),
    setQuote: vi.fn(() => { calls.push('setQuote'); }),
    send: vi.fn(async (_msg: string) => { calls.push('send'); }),
    getDraft: vi.fn(() => '原有草稿'),
    currentDraftKey: vi.fn(() => 'scope:ch:ch-1'),
  };
});

vi.mock('./chat.svelte.js', () => ({
  chat: { setScope: mocks.setScope, currentDraftKey: mocks.currentDraftKey, getDraft: mocks.getDraft, setDraft: mocks.setDraft, setQuote: mocks.setQuote, send: mocks.send },
}));
vi.mock('./ui.svelte.js', () => ({
  ui: { showCol: mocks.showCol },
}));

import {
  appendPolishRound,
  polishInstruction,
  quoteSelectionToChat,
  transferPolishToChat,
} from './bridge.svelte.js';
import type { ChapterNode } from './types.js';

const chapter: ChapterNode = {
  type: 'chapter',
  title: '第一章',
  relPath: 'manuscript/01.md',
  id: 'ch-1',
  wordCount: 0,
  scenes: [],
};

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.setScope.mockClear();
  mocks.showCol.mockClear();
  mocks.setDraft.mockClear();
  mocks.send.mockClear();
  mocks.getDraft.mockReturnValue('原有草稿');
});

describe('选区与对话桥', () => {
  it('quoteSelectionToChat：切 scope 后设置附件引用，不污染草稿', async () => {
    await quoteSelectionToChat(chapter, '第一行\n第二行');

    expect(mocks.setScope).toHaveBeenCalledWith('ch:ch-1');
    expect(mocks.setQuote).toHaveBeenCalledWith('scope:ch:ch-1', { label: '引用 · 第一章 · 7 字', text: '第一行\n第二行' });
    expect(mocks.setDraft).not.toHaveBeenCalled();
    expect(mocks.showCol).toHaveBeenCalledWith('chat');
  });

  it('transferPolishToChat：发送原文、逐轮记录与锚定替换指令', async () => {
    await transferPolishToChat(chapter, '原始选区', [
      { instruction: '更紧张', text: '第一版' },
      { instruction: '更简洁', text: '第二版' },
    ]);

    const message = mocks.send.mock.calls[0]?.[0] as unknown as string;
    expect(message).toContain('原始选区');
    expect(message).toContain('更紧张');
    expect(message).toContain('第一版');
    expect(message).toContain('更简洁');
    expect(message).toContain('第二版');
    expect(message).toContain('stage_chapter_proposal');
    expect(message).toContain('mode=replace');
    expect(message).toContain('original');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

describe('打磨记录纯函数', () => {
  it('appendPolishRound：追加且不修改原数组', () => {
    const rounds = [{ instruction: '旧指令', text: '旧版本' }];
    const next = appendPolishRound(rounds, '新指令', '新版本');
    expect(rounds).toEqual([{ instruction: '旧指令', text: '旧版本' }]);
    expect(next).toEqual([...rounds, { instruction: '新指令', text: '新版本' }]);
  });

  it('polishInstruction：空输入回落实际 variant', () => {
    expect(polishInstruction('  ', '润色这段文字')).toBe('润色这段文字');
    expect(polishInstruction('更紧张', '换一版')).toBe('更紧张');
  });
});
