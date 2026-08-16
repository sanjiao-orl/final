/**
 * paths.ts —— 壳侧目录约定收拢：作品内相对路径（相对 workDir）与危险工具放行去重键前缀
 * 统一从本模块引用，避免与 domain 侧的目录约定散落漂移。目录约定以 domain 契约为准。
 */

/** 章节正文根目录（相对 workDir）。 */
export const MANUSCRIPT_DIR = 'manuscript/';
/** 壳私有元数据目录（快照/回收站/笔记/账本等，相对 workDir）。 */
export const NOVEL_DIR = '.novel/';
/** 问题日志（CR 格式）默认路径（相对 workDir；ledger_diagnostics / issue_append / issue_set_status 的缺省）。 */
export const ISSUE_LOG_DEFAULT = 'editorial_notes/issues.md';
/** 软删回收站目录（相对 workDir）。 */
export const TRASH_DIR = `${NOVEL_DIR}trash/`;

/** 危险工具放行去重键前缀（approval 门与工具卡共用，必须同源）。 */
export const WRITE_KEY_PREFIX = 'write:';
export const DELETE_KEY_PREFIX = 'delete:';
/** 全稿导出 txt 的放行去重键（无目标参数）。 */
export const EXPORT_KEY = 'export';
