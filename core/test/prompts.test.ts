// 测试：core 提示词/skill 文件加载器（docs/decisions/0008）——
// 正常加载、缺文件回退、坏 frontmatter 跳过、BOM 容忍、多行 frontmatter、首次释放
// （缺则拷 / 未改动升级为新版 / 本地改过永不覆盖）、skill 清单同名遮蔽。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPersonas, collectSchemes, collectSkills, contentHash, loadPersona, loadPrompt, loadStyleSummary, parsePromptFile, readActiveScheme, releasePrompts, scanPersonas, scanSchemes, scanSkills, SHIPPED_FILE_HASHES } from '../src/prompts.js';

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

  it('frontmatter 容忍 UTF-8 BOM：带 BOM 的文件照常解析出键值与正文（书级手写文件常见）', () => {
    const parsed = parsePromptFile('\uFEFF---\nkind: skill\nname: 润色\ndescription: 去 AI 味\n---\n正文');
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.kind).toBe('skill');
    expect(parsed.frontmatter.name).toBe('润色');
    expect(parsed.body).toBe('正文');

    // 端到端：带 BOM 的书级手写 skill/persona 不再凭空消失
    const dir = makeTmpDir();
    writeTree(dir, {
      'bom-skill.md': '\uFEFF---\nkind: skill\nname: 带BOM技能\ndescription: d\n---\n正文',
      'personas/bom.md': '\uFEFF---\nkind: persona\nname: 带BOM角色\ndescription: d\n---\n正文',
    });
    expect(scanSkills(dir)).toEqual([{ name: '带BOM技能', description: 'd' }]);
    expect(collectPersonas(dir)).toEqual([{ name: '带BOM角色', description: 'd' }]);
  });

  it('多行 frontmatter：`key: |` 块标量保留换行，`key: >` 折叠为空格，缩进续行折进上一个单行值', () => {
    const block = parsePromptFile(
      '---\nkind: persona\nname: 责编\ndescription: |\n  第一行说明。\n  第二行说明。\n---\n正文'
    );
    expect(block.frontmatter.description).toBe('第一行说明。\n第二行说明。');

    const folded = parsePromptFile(
      '---\nkind: skill\nname: 润色\ndescription: >\n  长句被折叠成\n  一整行。\n---\n正文'
    );
    expect(folded.frontmatter.description).toBe('长句被折叠成 一整行。');

    const continued = parsePromptFile(
      '---\nkind: skill\nname: 润色\ndescription: 首行说明\n  缩进续行接上。\n---\n正文'
    );
    expect(continued.frontmatter.description).toBe('首行说明 缩进续行接上。');

    // 块标量之后回到普通键值；块内更深缩进剥公共前导空白
    const mixed = parsePromptFile(
      '---\nkind: skill\nname: 润色\ndescription: |\n  深一层\n    更深一层\nother: x\n---\n正文'
    );
    expect(mixed.frontmatter.description).toBe('深一层\n  更深一层');
    expect(mixed.frontmatter.other).toBe('x');
    expect(mixed.body).toBe('正文');
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

  it('热重载：同 mtime 但 size 变化仍刷新（缓存 {mtimeMs,size} 双因子，防同 mtime 陈旧）', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'chat.md');
    writeTree(dir, { 'chat.md': VALID_CHAT });
    expect(loadPrompt('chat', dir)).toBe('你是测试聊天助手。');

    // 改内容（size 变长）后把 mtime 拨回与旧值完全相同——只有 size 能区分新旧，需重读而非命中陈旧缓存。
    const before = fs.statSync(file).mtime;
    fs.writeFileSync(file, '---\nkind: prompt\napplies_to: chat\n---\n你是改版后长了更多字的聊天助手。', 'utf8');
    fs.utimesSync(file, before, before);
    expect(loadPrompt('chat', dir)).toBe('你是改版后长了更多字的聊天助手。');
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

  it('升级通道：hash 清单覆盖当前随包正本（改提示词须同步再生 manifest，防清单陈旧失守）', () => {
    // 真实随包目录里的规范文件，每个都应在清单里且当前内容 hash 在列——否则升级通道对它失效。
    const promptsDir = path.resolve(import.meta.dirname, '..', 'prompts');
    for (const rel of ['chat.md', 'review.md', 'collide.md', 'summary.md', 'quality-check.md', 'personas/责编.md', 'schemes/结构对抗型.md']) {
      expect(SHIPPED_FILE_HASHES[rel]).toBeDefined();
      expect(SHIPPED_FILE_HASHES[rel]!).toContain(contentHash(fs.readFileSync(path.join(promptsDir, rel), 'utf8')));
    }
  });

  it('升级通道：目标仍是历史随包版（作者没改过）→ 覆盖为新版，修复能送达存量安装', () => {
    const source = makeTmpDir();
    const target = makeTmpDir();
    writeTree(source, { 'chat.md': '修复后的新版聊天提示' });
    // 目标放真实随包正本的逐字节拷贝（其 hash 在清单内）
    const bundledChat = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'prompts', 'chat.md'), 'utf8');
    writeTree(target, { 'chat.md': bundledChat });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    releasePrompts(target, source);
    expect(fs.readFileSync(path.join(target, 'chat.md'), 'utf8')).toBe('修复后的新版聊天提示');
  });

  it('升级通道：目标被本地改过 → 跳过覆盖并 warn 提示，永不覆盖', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = makeTmpDir();
    const target = makeTmpDir();
    writeTree(source, { 'chat.md': '新版聊天提示' });
    writeTree(target, { 'chat.md': '---\nkind: prompt\napplies_to: chat\n---\n作者精心改过的本地版' });
    releasePrompts(target, source);
    expect(fs.readFileSync(path.join(target, 'chat.md'), 'utf8')).toContain('作者精心改过的本地版');
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('被本地修改过');
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

describe('角色与方案（决策 0010/0013）', () => {
  it('scanFiles kind 过滤：persona 与 skill 互不串扰，坏文件跳过', () => {
    const dir = makeTmpDir();
    writeTree(dir, {
      'a.md': '---\nkind: persona\nname: 责编\ndescription: 何时用…\n---\n正文',
      'b.md': '---\nkind: skill\nname: 润色\ndescription: 去 AI 味\n---\n正文',
      'c.md': '---\nkind: persona\ndescription: 缺 name\n---\n正文',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(scanPersonas(dir)).toEqual([{ name: '责编', description: '何时用…' }]);
    expect(scanSkills(dir)).toEqual([{ name: '润色', description: '去 AI 味' }]);
  });

  it('persona/scheme 缺 kind 的书级手写文件也接受（目录语境即类型，与 domain 口径对齐）；kind 错配仍跳过', () => {
    const personasDir = makeTmpDir();
    writeTree(personasDir, {
      'a.md': '---\nname: 无kind责编\ndescription: 手写没带kind\n---\n正文',
      'b.md': '---\nkind: skill\nname: 润色\ndescription: 串目录的 skill\n---\n正文',
    });
    expect(scanPersonas(personasDir)).toEqual([{ name: '无kind责编', description: '手写没带kind' }]);

    const schemesDir = makeTmpDir();
    writeTree(schemesDir, {
      'a.md': '---\nname: 无kind方案\nchat: 责编\n---\n备注',
      'b.md': '---\nkind: persona\nname: 责编\n---\n串目录的 persona',
    });
    expect(scanSchemes(schemesDir)).toEqual([{ name: '无kind方案', description: '', channels: { chat: '责编' } }]);

    // scanSkills 维持严格：无 kind 不接受（0008 契约不变）
    expect(scanSkills(personasDir)).toEqual([{ name: '润色', description: '串目录的 skill' }]);
  });

  it('scanSchemes：提取 chat/rewrite/review 三键为通道映射，缺省键省略', () => {
    const dir = makeTmpDir();
    writeTree(dir, {
      'a.md': '---\nkind: scheme\nname: 结构对抗型\ndescription: d\nchat: 责编\nreview: 责编\n---\n备注正文',
    });
    expect(scanSchemes(dir)).toEqual([
      { name: '结构对抗型', description: 'd', channels: { chat: '责编', review: '责编' } },
    ]);
    // rewrite 缺失 → 通道里不出现
    const onlyChat = makeTmpDir();
    writeTree(onlyChat, { 'a.md': '---\nkind: scheme\nname: x\ndescription: d\nchat: 小白读者\n---\n备注' });
    expect(scanSchemes(onlyChat)).toEqual([{ name: 'x', description: 'd', channels: { chat: '小白读者' } }]);
  });

  it('缺 frontmatter kind 的书级手写 persona/scheme 也接受（目录语境即类型，与 domain 口径对齐）', () => {
    const dir = makeTmpDir();
    writeTree(dir, {
      'a.md': '---\nname: 手写责编\ndescription: 无 kind\n---\n正文',
      'b.md': '---\nname: 手写方案\nchat: 责编\n---\n备注',
      'c.md': '---\nkind: skill\nname: 误放的技能\n---\n串目录跳过',
    });
    expect(scanPersonas(dir)).toEqual([
      { name: '手写责编', description: '无 kind' },
      { name: '手写方案', description: '' }, // 目录语境即类型：无 kind 文件两个扫描器都收，正常用法目录分离
    ]);
    expect(scanSchemes(dir)).toEqual([
      { name: '手写责编', description: '无 kind', channels: {} },
      { name: '手写方案', description: '', channels: { chat: '责编' } },
    ]);
  });

  it('collectPersonas：书级同名遮蔽 app 级，书级独有追加在后', () => {
    const app = makeTmpDir();
    const work = makeTmpDir();
    writeTree(app, {
      'personas/a.md': '---\nkind: persona\nname: 责编\ndescription: app 责编\n---\na',
      'personas/b.md': '---\nkind: persona\nname: 毒舌书评人\ndescription: app 毒舌\n---\na',
    });
    writeTree(work, {
      '.novel/personas/a.md': '---\nkind: persona\nname: 责编\ndescription: 书级责编\n---\nb',
      '.novel/personas/c.md': '---\nkind: persona\nname: 小白读者\ndescription: 书级小白\n---\nb',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(collectPersonas(app, work)).toEqual([
      { name: '责编', description: '书级责编' },
      { name: '毒舌书评人', description: 'app 毒舌' },
      { name: '小白读者', description: '书级小白' },
    ]);
  });

  it('collectSchemes：书级同名遮蔽 app 级', () => {
    const app = makeTmpDir();
    const work = makeTmpDir();
    writeTree(app, { 'schemes/a.md': '---\nkind: scheme\nname: 结构对抗型\ndescription: app\n---\na' });
    writeTree(work, {
      '.novel/schemes/a.md': '---\nkind: scheme\nname: 结构对抗型\ndescription: 书级\nchat: 小白读者\n---\nb',
    });
    expect(collectSchemes(app, work)).toEqual([
      { name: '结构对抗型', description: '书级', channels: { chat: '小白读者' } },
    ]);
  });

  it('readActiveScheme：缺文件返回 null，正常读单行 trim，空内容返回 null', () => {
    const work = makeTmpDir();
    expect(readActiveScheme(work)).toBeNull();
    writeTree(work, { '.novel/active-scheme': '  结构对抗型\n' });
    expect(readActiveScheme(work)).toBe('结构对抗型');
    const empty = makeTmpDir();
    writeTree(empty, { '.novel/active-scheme': '   \n\n' });
    expect(readActiveScheme(empty)).toBeNull();
  });

  it('loadPersona：按名取正文（去 frontmatter），书级遮蔽；找不到返回 null 并 warn', () => {
    // app 级（真实 core/prompts/personas）预置「责编」存在
    expect(loadPersona('责编')).toContain('有据');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadPersona('不存在的角色')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    // 书级同名遮蔽 app 级
    const work = makeTmpDir();
    writeTree(work, { '.novel/personas/责编.md': '---\nkind: persona\nname: 责编\ndescription: 书级\n---\n书级责编正文。' });
    expect(loadPersona('责编', work)).toBe('书级责编正文。');

    // 书级手写无 kind 也能按名解析（与 scanPersonas 宽容口径一致）
    const work2 = makeTmpDir();
    writeTree(work2, { '.novel/personas/手写角色.md': '---\nname: 手写角色\n---\n手写正文。' });
    expect(loadPersona('手写角色', work2)).toBe('手写正文。');
  });

  it('releasePrompts 缺则拷：子目录 persona/scheme 预置一并释放；有则不覆盖', () => {
    const source = makeTmpDir();
    const target = makeTmpDir();
    writeTree(source, {
      'chat.md': '随包聊天提示',
      'personas/责编.md': '---\nkind: persona\nname: 责编\n---\n正文',
      'schemes/结构对抗型.md': '---\nkind: scheme\nname: 结构对抗型\n---\n备注',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    releasePrompts(target, source);
    expect(fs.readFileSync(path.join(target, 'chat.md'), 'utf8')).toBe('随包聊天提示');
    expect(fs.readFileSync(path.join(target, 'personas', '责编.md'), 'utf8')).toContain('正文');
    expect(fs.readFileSync(path.join(target, 'schemes', '结构对抗型.md'), 'utf8')).toContain('备注');

    // 有则不覆盖：目标子目录已有用户改动保持不变
    const target2 = makeTmpDir();
    writeTree(target2, { 'personas/责编.md': '用户改过的' });
    releasePrompts(target2, source);
    expect(fs.readFileSync(path.join(target2, 'personas', '责编.md'), 'utf8')).toBe('用户改过的');
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

  it('同 mtime 但 size 变化仍刷新（styleSummary 缓存 {mtimeMs,size} 双因子）', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, '.novel', 'style.md');
    writeTree(dir, { '.novel/style.md': '## 摘要\n\n第一版。' });
    expect(loadStyleSummary(dir)).toBe('第一版。');

    const before = fs.statSync(file).mtime;
    fs.writeFileSync(file, '## 摘要\n\n第,二版——内容更长一些。', 'utf8');
    fs.utimesSync(file, before, before);
    expect(loadStyleSummary(dir)).toBe('第,二版——内容更长一些。');
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
