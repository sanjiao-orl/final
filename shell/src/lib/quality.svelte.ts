/**
 * quality.svelte.ts —— 章节质检（作家助手「章节风险提示」范式，壳私有小 store）：
 * 作者在章头点「质检」→ core POST /v1/quality/check（便宜模型：错别字/敏感词/用词不当）→
 * 结果面板展示风险段落，作者自行修改；不自动改、不拦截发布流转。
 */
import type { CoreClient } from './core.js';
import type { QualityFinding } from './types.js';

export class QualityStore {
  /** 质检请求在飞。 */
  checking = $state(false);
  /** 结果列表（null=尚无结果/已复位）；空数组=未发现风险。 */
  result = $state<QualityFinding[] | null>(null);
  /** 章标题（core 回传，面板头部展示）。 */
  chapterTitle = $state<string | null>(null);
  /** 正文过长被截断（结果可能不全），面板顶部提示。 */
  truncated = $state(false);
  /** 质检失败信息（红条样式展示）。 */
  error = $state<string | null>(null);
  /** 面板开合。 */
  open = $state(false);

  private client!: CoreClient;
  /** run 代际：防竞态——连点两章的质检时，先发的读回落后按代际丢弃。 */
  private seq = 0;

  init(client: CoreClient): void {
    this.client = client;
  }

  /**
   * 质检某章：打开面板进 loading 态 → 成功写结果 / 失败写 error；
   * 迟到的旧读回（seq 不匹配）直接丢弃，不覆盖新现场。
   */
  async run(workDir: string, relPath: string): Promise<void> {
    const seq = ++this.seq;
    this.open = true;
    this.checking = true;
    this.result = null;
    this.chapterTitle = null;
    this.truncated = false;
    this.error = null;
    try {
      const r = await this.client.qualityCheck(workDir, relPath);
      if (seq !== this.seq) return; // 已有更新的质检接管
      this.result = r.findings ?? [];
      this.chapterTitle = r.chapterTitle ?? null;
      this.truncated = r.truncated === true;
    } catch (err) {
      if (seq !== this.seq) return;
      this.result = null;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.seq) this.checking = false;
    }
  }

  /** 关闭面板并复位结果现场（下次点「质检」重新拉）。 */
  close(): void {
    this.seq++; // 在飞的读回一并作废
    this.open = false;
    this.checking = false;
    this.result = null;
    this.chapterTitle = null;
    this.truncated = false;
    this.error = null;
  }
}

export const quality = new QualityStore();
