// clipboard.ts 单测（任务 3）：Tauri 插件优先 → Web Clipboard 回落 → 双失败抛错。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(),
}));

import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { writeClipboardText } from './clipboard.js';

const pluginWrite = vi.mocked(writeText);

beforeEach(() => {
  pluginWrite.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('writeClipboardText', () => {
  it('插件成功：直接落定，不碰 Web Clipboard', async () => {
    pluginWrite.mockResolvedValue(undefined);
    const webWrite = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: webWrite } });
    await writeClipboardText('正文');
    expect(pluginWrite).toHaveBeenCalledWith('正文');
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('插件失败（浏览器 dev/权限缺失）：回落 navigator.clipboard.writeText', async () => {
    pluginWrite.mockRejectedValue(new Error('not in tauri'));
    const webWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: webWrite } });
    await writeClipboardText('平台格式正文');
    expect(webWrite).toHaveBeenCalledWith('平台格式正文');
  });

  it('插件失败且 Web Clipboard 也失败：错误原样抛出（调用方拼可行动提示）', async () => {
    pluginWrite.mockRejectedValue(new Error('not in tauri'));
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(writeClipboardText('x')).rejects.toThrow('denied');
  });

  it('插件失败且无 Web Clipboard：抛「剪贴板不可用」', async () => {
    pluginWrite.mockRejectedValue(new Error('not in tauri'));
    vi.stubGlobal('navigator', {});
    await expect(writeClipboardText('x')).rejects.toThrow('剪贴板不可用');
  });
});
