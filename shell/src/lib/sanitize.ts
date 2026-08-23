/**
 * sanitize.ts —— LLM/markdown 输出渲染进 webview DOM 前的统一净化（DOMPurify）。
 * chat 回复与 AI 采纳正文都是 LLM 输出（日常输入即不可信文本，提示注入可产出恶意 markup），
 * {@html} / innerHTML 前必须过这里——2026-08-23 外部评审提前项，取代 v4 方案「本地单用户不引入 DOMPurify」旧口径。
 * 白名单 = DOMPurify html profile（覆盖 marked GFM 全部产物：表格/任务列表/删除线/代码块）；
 * <style> 显式禁用（LLM 可经 raw HTML 块注入全应用样式）。CSP 只是兜底，净化是第一道闸。
 */
import DOMPurify, { type Config } from 'dompurify';

const CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style'],
};

/** 净化一段（可能含恶意标记的）HTML 字符串，返回白名单内的安全 HTML。 */
export function sanitizeHtml(html: string): string {
  if (!DOMPurify.isSupported) {
    // webview/jsdom 里不该走到这；裸 node 环境直接暴露而不是放行原文
    throw new Error('DOMPurify 无可用 DOM 环境（净化只应在 webview 或 jsdom 测试中调用）');
  }
  return DOMPurify.sanitize(html, CONFIG) as string;
}
