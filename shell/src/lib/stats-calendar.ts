/**
 * stats-calendar.ts —— 码字日历纯函数（不依赖 svelte，可单测）：
 * 日增量链（withDeltas）、最近 10 个自然周热力网格（buildCalendarGrid，列=周/行=周一~周日）、
 * 五档热力分级（levelOf）、摘要（summarize：今日/近7日均/记录天数/总字数）。
 * 数据口径：core 按日落账（每日一条当日总字数），delta=当日 − 上一记录日，首日 delta=null。
 */
export interface DailyStat {
  date: string;
  words: number;
}

export interface DailyStatDelta extends DailyStat {
  delta: number | null;
}

export interface CalendarCell {
  date: string;
  words?: number;
  delta?: number | null;
  level: number;
  future: boolean;
}

export interface CalendarSummary {
  todayWords: number | null;
  todayDelta: number | null;
  weekAvg: number;
  totalDays: number;
  totalWords: number;
}

export function withDeltas(days: DailyStat[]): DailyStatDelta[] {
  let previous: DailyStat | undefined;
  return days.map((day) => {
    const delta = previous ? day.words - previous.words : null;
    previous = day;
    return { ...day, delta };
  });
}

export function levelOf(delta: number | null, recorded: boolean): number {
  if (!recorded) return 0;
  if (delta === null || delta < 1000) return 1;
  if (delta < 2000) return 2;
  if (delta < 4000) return 3;
  return 4;
}

function parseDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}
function dateString(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

export function buildCalendarGrid(days: DailyStat[], todayStr: string): CalendarCell[][] {
  const today = parseDate(todayStr);
  const mondayOffset = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - mondayOffset - 63);
  const stats = new Map(withDeltas(days).map((day) => [day.date, day]));
  return Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => {
      const date = new Date(start);
      date.setDate(start.getDate() + col * 7 + row);
      const key = dateString(date);
      const stat = stats.get(key);
      const cell: CalendarCell = { date: key, level: levelOf(stat?.delta ?? null, !!stat), future: date > today };
      if (stat) {
        cell.words = stat.words;
        cell.delta = stat.delta;
      }
      return cell;
    }),
  );
}

export function summarize(days: DailyStat[], todayStr: string): CalendarSummary {
  const dated = withDeltas(days);
  const today = parseDate(todayStr);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  const recent = dated.filter((day) => {
    const date = parseDate(day.date);
    return date >= weekStart && date <= today;
  });
  const byDate = new Map(recent.map((day) => [day.date, day]));
  let weekTotal = 0;
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + i);
    weekTotal += byDate.get(dateString(date))?.delta ?? 0;
  }
  const todayStat = dated.find((day) => day.date === todayStr);
  const latest = dated[dated.length - 1];
  return {
    todayWords: todayStat?.words ?? null,
    todayDelta: todayStat?.delta ?? null,
    weekAvg: Math.trunc(weekTotal / 7),
    totalDays: days.length,
    totalWords: latest?.words ?? 0,
  };
}

/** 今日日期串（本地时区 YYYY-MM-DD，与 core 落账口径一致）。 */
export function todayIso(): string {
  return dateString(new Date());
}
