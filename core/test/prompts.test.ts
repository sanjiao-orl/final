// 测试：core 提示词/skill 文件加载器（docs/decisions/0008）——
// 正常加载、缺文件回退、坏 frontmatter 跳过、首次释放（缺则拷/有则不覆盖）、skill 清单同名遮蔽。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectSkills, loadPrompt, parsePromptFile, releasePrompts, scanSkills } from '../src/prompts.js';

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
