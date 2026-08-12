/**
 * dialog.svelte.ts —— 壳内模态对话框（prompt/confirm 的 WebView2 替代）。
 * Tauri 2 的 WebView2 不实现 window.prompt/confirm（直接返回 null/false），
 * 新建卷/新建章/删除等依赖输入确认的流程全部改走这里；回调式、单例挂载在 App。
 */
export interface DialogRequest {
  kind: 'prompt' | 'confirm';
  message: string;
  placeholder?: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 交结果：prompt 返回输入串（取消=null）；confirm 返回 true/false。 */
  resolve: (value: string | null) => void;
}

class DialogStore {
  current = $state<DialogRequest | null>(null);
  /** prompt 输入现场。 */
  input = $state('');

  prompt(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    okLabel?: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      this.input = opts.defaultValue ?? '';
      this.current = { kind: 'prompt', ...opts, resolve };
    });
  }

  confirm(opts: { message: string; okLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      this.current = { kind: 'confirm', ...opts, resolve: (v) => resolve(v !== null) };
    });
  }

  /** 确定：prompt 返回输入（空串也返回，由调用方决定），confirm 返回 'ok' 标记。 */
  ok(): void {
    const r = this.current;
    if (!r) return;
    const value = r.kind === 'prompt' ? this.input : 'ok';
    this.current = null;
    r.resolve(value);
  }

  /** 取消 / Esc / 点遮罩：prompt 返回 null，confirm 返回 false。 */
  cancel(): void {
    const r = this.current;
    if (!r) return;
    this.current = null;
    r.resolve(null);
  }
}

export const dialog = new DialogStore();
