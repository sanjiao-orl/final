/**
 * prompts.test.ts —— domain 最小提示词/skill 加载器（与 core/src/prompts.ts 互为镜像）。
 * 覆盖：cold-read 正常/缺文件/坏 frontmatter、skill_read 命中与未命中、ledgerSlice 从 cold-read.md 加载模板。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ledgerSlice } from '../src/ledger.js';
import { findSkillByName, loadPrompt, readSkillBody } from '../src/prompts.js';
import { makeWorkDir, writeTree } from './helpers.js';

const COLD_READ_TEMPLATE = `---
kind: prompt
applies_to: cold_read
---
# 冷读输入（测试模板）

## 读者契约
来自文件的读者契约

## 账本（当前状态）

{{账本切片}}
## 本章正文（唯一注入章）

### {{章节标题}}

{{章节内容}}

## 问题日志（尾部，供续读上下文）

{{问题日志尾部}}
`;

describe('domain prompt 加载器', () => {
  it('正常加载 cold-read.md 去 frontmatter 取正文', () => {
    const dir = makeWorkDir();
    writeTree(dir, { 'cold-read.md': COLD_READ_TEMPLATE });
    expect(loadPrompt('cold_read', dir)).toContain('来自文件的读者契约');
  });

  it('缺文件返回 null，坏 frontmatter（缺 kind / applies_to 不匹配）返回 null', () => {
    const dir = makeWorkDir();
    writeTree(dir, { 'cold-read.md': '---\nkind: skill\nname: 润色\n---\n不是 prompt' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadPrompt('cold_read', dir)).toBeNull();
    writeTree(dir, { 'cold-read.md': '---\napplies_to: cold_read\n---\n不是 prompt' });
    expect(loadPrompt('cold_read', dir)).toBeNull();
  });

  it('改文件（mtime/size 变化）后重读即生效，不要求重启（mtime 热重载）', () => {
    const dir = makeWorkDir();
    const file = path.join(dir, 'cold-read.md');
    writeTree(dir, { 'cold-read.md': COLD_READ_TEMPLATE });
    expect(loadPrompt('cold_read', dir)).toContain('来自文件的读者契约');
    // 改内容并强制 mtime 前移（Windows mtime 粒度可能粗于连续写入间隔，utimes 兜底保证判变）
    fs.writeFileSync(file, COLD_READ_TEMPLATE.replace('来自文件的读者契约', '热重载后的读者契约'), 'utf8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    expect(loadPrompt('cold_read', dir)).toContain('热重载后的读者契约');
  });

  it('文件被删除后重读返回 null（缓存按出现/消失失效）', () => {
    const dir = makeWorkDir();
    writeTree(dir, { 'cold-read.md': COLD_READ_TEMPLATE });
    expect(loadPrompt('cold_read', dir)).toContain('来自文件的读者契约');
    fs.rmSync(path.join(dir, 'cold-read.md'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadPrompt('cold_read', dir)).toBeNull();
  });
});

describe('skill_read', () => {
  it('命中书级 skill 返回正文（同名遮蔽 app 级）', () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    writeTree(app, {
      'skill-a.md': '---\nkind: skill\nname: 润色\ndescription: app 润色\n---\napp 正文',
    });
    writeTree(work, {
      '.novel/skills/skill-a.md': '---\nkind: skill\nname: 润色\ndescription: 书级润色\n---\n书级正文',
    });
    expect(readSkillBody(work, '润色', app)).toBe('书级正文');
  });

  it('书级未命中时回落到 app 级', () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    writeTree(app, {
      'skill-a.md': '---\nkind: skill\nname: 润色\ndescription: app 润色\n---\napp 正文',
    });
    expect(readSkillBody(work, '润色', app)).toBe('app 正文');
  });

  it('未命中抛中文错', () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    expect(() => readSkillBody(work, '不存在的 skill', app)).toThrow(/skill_read 找不到 skill/);
  });

  it('findSkillByName 只收 kind:skill 且带 name 的文件', () => {
    const dir = makeWorkDir();
    writeTree(dir, {
      'a.md': '---\nkind: skill\nname: 润色\n---\n正文',
      'b.md': '---\nkind: prompt\napplies_to: cold_read\n---\n不是 skill',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(findSkillByName(dir, '润色')?.body).toBe('正文');
    expect(findSkillByName(dir, '不存在')).toBeNull();
  });
});

describe('ledgerSlice 从 cold-read.md 加载模板', () => {
  it('NOVEL_PROMPT_DIR 指向的 cold-read.md 作为 slice 模板，动态段被替换', () => {
    const work = makeWorkDir();
    const prompts = makeWorkDir();
    writeTree(prompts, { 'cold-read.md': COLD_READ_TEMPLATE });
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n本章正文AAA。' });
    vi.stubEnv('NOVEL_PROMPT_DIR', prompts);
    try {
      const { slice } = ledgerSlice(work, 'manuscript/第1章.md');
      expect(slice).toContain('来自文件的读者契约');
      expect(slice).toContain('本章正文AAA。');
      expect(slice).not.toContain('{{账本切片}}');
      expect(slice).not.toContain('{{章节标题}}');
      expect(slice).not.toContain('{{章节内容}}');
      expect(slice).not.toContain('{{问题日志尾部}}');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('cold-read.md 缺失/损坏时回退兜底常量（读者契约仍在）', () => {
    const work = makeWorkDir();
    const prompts = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n本章正文AAA。' });
    vi.stubEnv('NOVEL_PROMPT_DIR', prompts);
    try {
      const { slice } = ledgerSlice(work, 'manuscript/第1章.md');
      expect(slice).toContain('读者契约');
      expect(slice).toContain('本章正文AAA。');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
