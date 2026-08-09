/**
 * suggest.ts —— 暂存候选的内联装饰：original 打删除线，proposed 以建议色插入其后，
 * 尾部带 ✓ 采纳 / × 丢弃按钮（AI 产出全部先进暂存区，这里只是预览，落地走批量采纳）。
 *
 * 装饰随文档事务重建（锚随文走；原文被改到找不到时装饰自动消失，采纳时按 pm-search 重新定位并显式报错）。
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findTextRanges } from './pm-search.js';

export interface SuggestItem {
  id: string;
  original: string;
  proposed: string;
}

export interface SuggestOptions {
  getItems: () => SuggestItem[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

export const suggestKey = new PluginKey<DecorationSet>('suggest');

/** 外部触发装饰重建（候选列表变化后调用）。 */
export function refreshSuggests(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(suggestKey, true));
}

function buildDecorations(doc: PMNode, opts: SuggestOptions): DecorationSet {
  const decos: Decoration[] = [];
  for (const item of opts.getItems()) {
    const range = findTextRanges(doc, item.original)[0]; // 多命中装饰第一个；采纳时按唯一定位校验
    if (!range) continue; // 原文已被改没：不装饰，采纳/丢弃仍可在抽屉里操作
    decos.push(Decoration.inline(range.from, range.to, { class: 'suggest-del' }));
    decos.push(
      Decoration.widget(
        range.to,
        () => {
          const wrap = document.createElement('span');
          wrap.className = 'suggest-widget';
          wrap.dataset['candidateId'] = item.id;

          const ins = document.createElement('span');
          ins.className = 'suggest-ins';
          ins.textContent = item.proposed.replace(/\n+/g, '⏎');
          wrap.appendChild(ins);

          const accept = document.createElement('button');
          accept.className = 'suggest-btn accept';
          accept.textContent = '✓';
          accept.title = '采纳这条';
          accept.addEventListener('mousedown', (e) => e.preventDefault());
          accept.addEventListener('click', () => opts.onAccept(item.id));
          wrap.appendChild(accept);

          const reject = document.createElement('button');
          reject.className = 'suggest-btn reject';
          reject.textContent = '×';
          reject.title = '丢弃这条';
          reject.addEventListener('mousedown', (e) => e.preventDefault());
          reject.addEventListener('click', () => opts.onReject(item.id));
          wrap.appendChild(reject);

          return wrap;
        },
        { side: 1, key: `suggest-${item.id}` },
      ),
    );
  }
  return DecorationSet.create(doc, decos);
}

export const Suggest = Extension.create<SuggestOptions>({
  name: 'suggest',

  addOptions() {
    return {
      getItems: () => [],
      onAccept: () => {},
      onReject: () => {},
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin<DecorationSet>({
        key: suggestKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc, opts),
          apply: (tr, old, _, newState) => {
            if (tr.getMeta(suggestKey) || tr.docChanged) return buildDecorations(newState.doc, opts);
            return old;
          },
        },
        props: {
          decorations(state) {
            return suggestKey.getState(state);
          },
        },
      }),
    ];
  },
});
