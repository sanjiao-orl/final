// 测试：core 提示词/skill 文件加载器（docs/decisions/0008）——
// 正常加载、缺文件回退、坏 frontmatter 跳过、首次释放（缺则拷/有则不覆盖）、skill 清单同名遮蔽。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectSkills, loadPrompt, loadStyleSummary, parsePromptFile, releasePrompts, scanSkills } from '../src/prompts.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-prompts-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const VALID_CHAT = '---\nkind: prompt\napplies_to: chat\n---\n你是测试聊天助手。';

describe('core prompt 加载器', () => {
  it('正常加载：去 frontmatter 取正文', () => {
    const dir = makeTmpDir();
    writeTree(dir, { 'chat.md': VALID_CHAT });
    expect(loadPrompt('chat', dir)).toBe('你是测试聊天助手。');
  });

  it('文件缺失：回退一行兜底提示并 warn，不抛错', () => {
    const dir = makeTmpDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadPrompt('chat', dir)).toBe('你是中文小说写作助手。');
    expect(warn).toHaveBeenCalled();
  });

  it('坏 frontmatter（无 frontmatter / 缺 kind / applies_to 不匹配）：回退兜底并 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [
      '没有 frontmatter 的正文',
      '---\napplies_to: chat\n---\n缺 kind',
      '---\nkind: prompt\napplies_to: review\n---\n错配',
    ];
    for (const content of cases) {
      const dir = makeTmpDir();
      writeTree(dir, { 'chat.md': content });
      expect(loadPrompt('chat', dir)).toBe('你是中文小说写作助手。');
    }
    expect(warn).toHaveBeenCalledTimes(cases.length);
  });

  it('parsePromptFile：无 frontmatter 时 body 即全文', () => {
    const parsed = parsePromptFile('就是正文');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe('就是正文');
  });

  it('热重载：改文件后 loadPrompt 拿到新内容（决策 0008「改文件即生效」）', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'chat.md');
    writeTree(dir, { 'chat.md': VALID_CHAT });
    expect(loadPrompt('chat', dir)).toBe('你是测试聊天助手。');

    // 改内容并显式拨动 mtime（防文件系统时间精度抖动：同 ms 内写入可能 mtimeMs 不变）
    fs.writeFileSync(file, '---\nkind: prompt\napplies_to: chat\n---\n你是改版后的聊天助手。', 'utf8');
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(file, bumped, bumped);
    expect(loadPrompt('chat', dir)).toBe('你是改版后的聊天助手。');
  });

  it('热重载：文件被删后 loadPrompt 回退兜底（文件消失即失效，不用陈旧缓存）', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'chat.md');
    writeTree(dir, { 'chat.md': VALID_CHAT });
    expect(loadPrompt('chat', dir)).toBe('你是测试聊天助手。');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.rmSync(file);
    expect(loadPrompt('chat', dir)).toBe('你是中文小说写作助手。');
    expect(warn).toHaveBeenCalled();
  });
});

describe('首次运行释放', () => {
  it('缺则拷：目标目录缺少规范文件时从随包目录补缺', () => {
    const source = makeTmpDir();
    const target = makeTmpDir();
    writeTree(source, { 'chat.md': '随包聊天提示' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    releasePrompts(target, source);
    expect(fs.readFileSync(path.join(target, 'chat.md'), 'utf8')).toBe('随包聊天提示');
  });

  it('有则不覆盖：目标已有文件保持用户改动', () => {
    const source = makeTmpDir();
    const target = makeTmpDir();
    writeTree(source, { 'chat.md': '随包聊天提示' });
    writeTree(target, { 'chat.md': '用户改过的聊天提示' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    releasePrompts(target, source);
    expect(fs.readFileSync(path.join(target, 'chat.md'), 'utf8')).toBe('用户改过的聊天提示');
  });
});

describe('skill 清单', () => {
  it('扫描只收 kind:skill 且带 name 的文件，坏文件跳过', () => {
    const dir = makeTmpDir();
    writeTree(dir, {
      'a.md': '---\nkind: skill\nname: 润色\ndescription: 去 AI 味\n---\n正文',
      'b.md': '---\nkind: prompt\napplies_to: chat\n---\n不是 skill',
      'c.md': '没有 frontmatter',
      'd.md': '---\nkind: skill\ndescription: 缺 name\n---\n正文',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skills = scanSkills(dir);
    expect(skills).toEqual([{ name: '润色', description: '去 AI 味' }]);
  });

  it('书级同名遮蔽 app 级，书级独有 skill 追加在后', () => {
    const app = makeTmpDir();
    const work = makeTmpDir();
    writeTree(app, {
      'skill-a.md': '---\nkind: skill\nname: 润色\ndescription: app 润色\n---\napp',
      'skill-b.md': '---\nkind: skill\nname: 体检\ndescription: app 体检\n---\napp',
    });
    writeTree(work, {
      '.novel/skills/skill-a.md': '---\nkind: skill\nname: 润色\ndescription: 书级润色\n---\nbook',
      '.novel/skills/skill-c.md': '---\nkind: skill\nname: 书级技能\ndescription: 只在本书\n---\nbook',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(collectSkills(app, work)).toEqual([
      { name: '润色', description: '书级润色' },
      { name: '体检', description: 'app 体检' },
      { name: '书级技能', description: '只在本书' },
    ]);
  });
});

describe('loadStyleSummary 声口摘要', () => {
  it('提取 `## 摘要` 节内容（到下一个 `## ` 标题止，不含后续节）', () => {
    const dir = makeTmpDir();
    writeTree(dir, {
      '.novel/style.md':
        '# 声口档案\n\n主角冷峻克制，对话短促。\n\n## 摘要\n\n惜字如金，兵器用长句，情绪靠动作。\n\n## 节奏\n\n更多细节。',
    });
    expect(loadStyleSummary(dir)).toBe('惜字如金，兵器用长句，情绪靠动作。');
  });

  it('摘要节在文件任意位置都生效（frontmatter 后也能取到）', () => {
    const dir = makeTmpDir();
    writeTree(dir, {
      '.novel/style.md': '---\nkind: style\nname: demo\n---\n## 摘要\n\n带头文件也认。',
    });
    expect(loadStyleSummary(dir)).toBe('带头文件也认。');
  });

  it('无 `## 摘要` 节：回退正文前 1500 字符', () => {
    const dir = makeTmpDir();
    writeTree(dir, { '.novel/style.md': '没有摘要节的一段声口正文。'.repeat(5) });
    expect(loadStyleSummary(dir)).toBe('没有摘要节的一段声口正文。'.repeat(5));
  });

  it('无 `## 摘要` 节且超长：截断到 1500 字符并加省略标注', () => {
    const dir = makeTmpDir();
    writeTree(dir, { '.novel/style.md': '没有摘要节的长正文。'.repeat(300) }); // 3300 字符
    const summary = loadStyleSummary(dir)!;
    const marker = '\n…（声口摘要超 1500 字符，已截断）';
    expect(summary.length).toBe(1500 + marker.length);
    expect(summary.startsWith('没有摘要节的长正文。')).toBe(true);
    expect(summary).toContain('已截断');
  });

  it('摘要节超长：截断到 1500 字符并加省略标注', () => {
    const dir = makeTmpDir();
    writeTree(dir, { '.novel/style.md': `## 摘要\n\n${'长'.repeat(2000)}` });
    const summary = loadStyleSummary(dir)!;
    const marker = '\n…（声口摘要超 1500 字符，已截断）';
    expect(summary.length).toBe(1500 + marker.length);
    expect(summary.startsWith('长'.repeat(1500))).toBe(true);
    expect(summary).toContain('已截断');
  });

  it('摘要节为空（只含空白）→ null（调用方静默跳过）', () => {
    const dir = makeTmpDir();
    writeTree(dir, { '.novel/style.md': '## 摘要\n\n   \n' });
    expect(loadStyleSummary(dir)).toBeNull();
  });

  it('文件不存在/不可读 → null', () => {
    const dir = makeTmpDir();
    expect(loadStyleSummary(dir)).toBeNull();
  });

  it('mtime 热重载：改文件后拿到新摘要（决策 0008「改文件即生效」同口径）', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, '.novel', 'style.md');
    writeTree(dir, { '.novel/style.md': '## 摘要\n\n第一版。' });
    expect(loadStyleSummary(dir)).toBe('第一版。');

    // 改内容并显式拨动 mtime（防文件系统时间精度抖动：同 ms 内写入可能 mtimeMs 不变）
    fs.writeFileSync(file, '## 摘要\n\n第二版。', 'utf8');
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(file, bumped, bumped);
    expect(loadStyleSummary(dir)).toBe('第二版。');
  });

  it('热重载：文件被删后 → null（文件消失即失效，不用陈旧缓存）', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, '.novel', 'style.md');
    writeTree(dir, { '.novel/style.md': '## 摘要\n\n第一版。' });
    expect(loadStyleSummary(dir)).toBe('第一版。');
    fs.rmSync(file);
    expect(loadStyleSummary(dir)).toBeNull();
  });
});
