export function setFrontmatterStatus(fmRaw: string, value: string): string {
  if (!fmRaw) return `---\nstatus: ${value}\n---\n\n`;
  const lines = fmRaw.split(/(?<=\n)/);
  const status = /^status\s*:/;
  const index = lines.findIndex((line) => status.test(line.trim()));
  if (index >= 0) {
    lines[index] = lines[index]!.replace(/^(\s*status\s*:\s*).*?(\r?\n)?$/, `$1${value}$2`);
    return lines.join('');
  }
  const opening = (lines[0]?.trim() === '---' ? 1 : 0);
  lines.splice(opening, 0, `status: ${value}\n`);
  return lines.join('');
}

export function nextChapterStatus(status: string | undefined): string {
  if (status === '草稿') return '已发布';
  if (status === '已发布') return '已校对';
  return '草稿';
}
