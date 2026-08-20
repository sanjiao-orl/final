// 测试：GET /v1/posture —— 姿态清单（app 级 + 书级遮蔽 + 激活方案名读取，决策 0010/0013）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTestServer } from './helpers.js';

interface PersonaEntry { name: string; description: string; source: 'app' | 'work'; }
interface SchemeEntry { name: string; description: string; channels: Record<string, string>; source: 'app' | 'work'; }
interface PostureBody { personas: PersonaEntry[]; schemes: SchemeEntry[]; activeScheme: string | null; }

describe('GET /v1/posture 姿态清单', () => {
  it('workDir 省略 → 只回 app 级角色/方案，activeScheme=null；缺 token 401', async () => {
    const s = await startTestServer();
    try {
      // 未授权 401
      const noAuth = await fetch(`${s.baseUrl}/v1/posture`);
      expect(noAuth.status).toBe(401);

      const res = await fetch(`${s.baseUrl}/v1/posture`, { headers: { Authorization: `Bearer ${s.token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as PostureBody;
      const personaNames = body.personas.map((p) => p.name);
      expect(personaNames).toContain('责编');
      expect(personaNames).toContain('讨论陪练');
      expect(personaNames).toContain('毒舌书评人');
      expect(personaNames).toContain('小白读者');
      const schemeNames = body.schemes.map((sc) => sc.name);
      expect(schemeNames).toContain('结构对抗型');
      expect(schemeNames).toContain('体验优先型');
      expect(body.personas.every((p) => p.source === 'app')).toBe(true);
      expect(body.schemes.every((sc) => sc.source === 'app')).toBe(true);
      expect(body.activeScheme).toBeNull();
      // 方案通道映射已解析（rewrite 不绑定 → 无 rewrite 键）
      const target = body.schemes.find((sc) => sc.name === '结构对抗型')!;
      expect(target.channels.chat).toBe('责编');
      expect(target.channels.review).toBe('责编');
      expect(target.channels.rewrite).toBeUndefined();
      const exp = body.schemes.find((sc) => sc.name === '体验优先型')!;
      expect(exp.channels.chat).toBe('小白读者');
      expect(exp.channels.review).toBe('小白读者');
    } finally {
      await s.close();
    }
  });

  it('带 workDir：书级同名遮蔽 app 级（source=work）、书级独有追加；activeScheme 读指针文件', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-posture-'));
    fs.mkdirSync(path.join(workDir, '.novel', 'personas'), { recursive: true });
    fs.mkdirSync(path.join(workDir, '.novel', 'schemes'), { recursive: true });
    // 书级遮蔽 app 级「责编」
    fs.writeFileSync(
      path.join(workDir, '.novel', 'personas', '责编.md'),
      '---\nkind: persona\nname: 责编\ndescription: 书级责编\n---\nb',
      'utf8'
    );
    // 书级同名遮蔽结构对抗型（改通道绑定），书级独有加一套
    fs.writeFileSync(
      path.join(workDir, '.novel', 'schemes', '结构对抗型.md'),
      '---\nkind: scheme\nname: 结构对抗型\ndescription: 书级结构\nchat: 毒舌书评人\n---\ns',
      'utf8'
    );
    fs.writeFileSync(
      path.join(workDir, '.novel', 'schemes', '体验优先型.md'),
      '---\nkind: scheme\nname: 体验优先型\ndescription: 书级体验\n---\ns',
      'utf8'
    );
    fs.writeFileSync(path.join(workDir, '.novel', 'active-scheme'), '体验优先型\n', 'utf8');
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/posture?workDir=${encodeURIComponent(workDir)}`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as PostureBody;
      const 责编 = body.personas.find((p) => p.name === '责编')!;
      expect(责编.source).toBe('work');
      expect(责编.description).toBe('书级责编');
      const structure = body.schemes.find((sc) => sc.name === '结构对抗型')!;
      expect(structure.source).toBe('work');
      expect(structure.channels.chat).toBe('毒舌书评人');
      expect(body.activeScheme).toBe('体验优先型');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('workDir 不存在 → 400（同 chat/rewrite 的合法性校验口径）', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(
        `${s.baseUrl}/v1/posture?workDir=${encodeURIComponent(path.join(os.tmpdir(), 'core-posture-no-such'))}`,
        { headers: { Authorization: `Bearer ${s.token}` } }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('workDir');
    } finally {
      await s.close();
    }
  });
});
