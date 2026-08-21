/**
 * clipboard.ts —— 剪贴板写入（平台格式复制，任务 3）：
 * Tauri clipboard-manager 插件优先；非 Tauri 环境（浏览器 dev）或插件调用失败时
 * 回落 Web Clipboard API；两条路都不通抛错，由调用方给可行动提示。
 */
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/** 写剪贴板：插件 → navigator.clipboard 两级回落；都失败抛 Error。 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await writeText(text);
    return;
  } catch {
    // 插件不可用（浏览器 dev / 权限缺失 / 非安全上下文）：回落 Web Clipboard
  }
  const web = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (web?.writeText) {
    await web.writeText(text);
    return;
  }
  throw new Error('剪贴板不可用（Tauri 插件与 Web Clipboard 均失败）');
}
