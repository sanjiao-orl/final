// stats-calendar.ts 单测（任务 1c）：日增量链 / 10 周热力网格 / 五档分级 / 摘要。
import { describe, expect, it } from 'vitest';
import { buildCalendarGrid, levelOf, summarize, withDeltas, type DailyStat } from './stats-calendar.js';

/** 测试侧日期平移（本地时区，与被测同口径）。 */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getDay(); // 0=周日
}

describe('withDeltas', () => {
  it('首个记录日 delta=null，之后=当日 − 上一记录日', () => {
    const days: DailyStat[] = [
      { date: '2026-08-01', words: 1000 },
      { date: '2026-08-03', words: 1500 }, // 跨空档日：与上一记录日比
      { date: '2026-08-04', words: 3600 },
    ];
    expect(withDeltas(days).map((d) => d.delta)).toEqual([null, 500, 2100]);
  });

  it('负 delta（字数回退）如实保留', () => {
    const days: DailyStat[] = [
      { date: '2026-08-01', words: 1500 },
      { date: '2026-08-02', words: 1200 },
    ];
    expect(withDeltas(days)[1]?.delta).toBe(-300);
  });

  it('空数组 → 空', () => {
    expect(withDeltas([])).toEqual([]);
  });
});

describe('levelOf 全档边界', () => {
  it('无记录一律 0（不论 delta）', () => {
    expect(levelOf(null, false)).toBe(0);
    expect(levelOf(9999, false)).toBe(0);
  });
  it('有记录但首日（delta=null）→ 1', () => {
    expect(levelOf(null, true)).toBe(1);
  });
  it('负 delta 归 1', () => {
    expect(levelOf(-1, true)).toBe(1);
    expect(levelOf(-5000, true)).toBe(1);
  });
  it('999→1 / 1000→2 / 1999→2 / 2000→3 / 3999→3 / 4000→4', () => {
    expect(levelOf(999, true)).toBe(1);
    expect(levelOf(1000, true)).toBe(2);
    expect(levelOf(1999, true)).toBe(2);
    expect(levelOf(2000, true)).toBe(3);
    expect(levelOf(3999, true)).toBe(3);
    expect(levelOf(4000, true)).toBe(4);
  });
  it('0 与超高档', () => {
    expect(levelOf(0, true)).toBe(1);
    expect(levelOf(99999, true)).toBe(4);
  });
});

describe('buildCalendarGrid', () => {
  const TODAY = '2026-08-12';
  const todayRow = (dayOfWeek(TODAY) + 6) % 7; // 今日在末列的行号（0=周一）

  it('结构：7 行（周一~周日）× 10 列（最近 10 个自然周）', () => {
    const grid = buildCalendarGrid([], TODAY);
    expect(grid).toHaveLength(7);
    for (const row of grid) expect(row).toHaveLength(10);
  });

  it('周对齐：第 0 行全周一、第 6 行全周日；70 格日期连续不断档', () => {
    const grid = buildCalendarGrid([], TODAY);
    for (let c = 0; c < 10; c++) {
      expect(dayOfWeek(grid[0]![c]!.date)).toBe(1);
      expect(dayOfWeek(grid[6]![c]!.date)).toBe(0);
    }
    for (let c = 0; c < 10; c++) {
      for (let r = 0; r < 6; r++) {
        expect(addDays(grid[r]![c]!.date, 1)).toBe(grid[r + 1]![c]!.date);
      }
      if (c < 9) expect(addDays(grid[6]![c]!.date, 1)).toBe(grid[0]![c + 1]!.date);
    }
  });

  it('10 周窗口含本周：末列含今日；首列周一 = 本周一 − 63 天', () => {
    const grid = buildCalendarGrid([], TODAY);
    expect(grid[todayRow]![9]!.date).toBe(TODAY); // 末列含今日
    const thisMonday = addDays(TODAY, -todayRow);
    expect(grid[0]![9]!.date).toBe(thisMonday);
    expect(grid[0]![0]!.date).toBe(addDays(thisMonday, -63));
  });

  it('未来日 future=true：仅末列今日之后的格；今日与过去为 false', () => {
    const grid = buildCalendarGrid([], TODAY);
    let futureCount = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (cell.future) futureCount++;
        expect(cell.future).toBe(cell.date > TODAY);
      }
    }
    expect(futureCount).toBe(6 - todayRow); // 本周剩余天数
  });

  it('记录格带 words/delta/level；无记录格 words 缺省、level 0', () => {
    const d1 = addDays(TODAY, -2);
    const d2 = addDays(TODAY, -1);
    const grid = buildCalendarGrid(
      [
        { date: d1, words: 1000 },
        { date: d2, words: 5200 }, // delta 4200 → level 4
      ],
      TODAY,
    );
    const flat = grid.flat();
    const c1 = flat.find((c) => c.date === d1)!;
    const c2 = flat.find((c) => c.date === d2)!;
    expect(c1).toMatchObject({ words: 1000, delta: null, level: 1, future: false });
    expect(c2).toMatchObject({ words: 5200, delta: 4200, level: 4, future: false });
    const blank = flat.find((c) => c.date === addDays(TODAY, -3))!;
    expect(blank.words).toBeUndefined();
    expect(blank.delta).toBeUndefined();
    expect(blank.level).toBe(0);
    expect(blank.future).toBe(false);
  });
});

describe('summarize', () => {
  const TODAY = '2026-08-12';

  it('weekAvg：最近 7 自然日（含今日）delta 和/7 取整；无记录日与首日 null 按 0', () => {
    const days: DailyStat[] = [
      { date: addDays(TODAY, -8), words: 500 }, // 窗口外，不影响 weekAvg
      { date: addDays(TODAY, -5), words: 900 }, // delta 400
      // -4、-3、-2 空档按 0
      { date: addDays(TODAY, -1), words: 400 }, // delta -500（负也计入）
      { date: TODAY, words: 2400 }, // delta 2000
    ];
    const s = summarize(days, TODAY);
    expect(s.todayWords).toBe(2400);
    expect(s.todayDelta).toBe(2000);
    expect(s.weekAvg).toBe(Math.trunc((400 + -500 + 2000) / 7)); // 271
    expect(s.totalDays).toBe(4);
    expect(s.totalWords).toBe(2400); // 最新记录日 words
  });

  it('窗口内首日 delta=null 按 0 计入 weekAvg', () => {
    const days: DailyStat[] = [{ date: addDays(TODAY, -3), words: 700 }]; // 唯一记录日，在窗口内
    const s = summarize(days, TODAY);
    expect(s.weekAvg).toBe(0); // null → 0
    expect(s.todayWords).toBeNull(); // 今日无记录
    expect(s.todayDelta).toBeNull();
    expect(s.totalDays).toBe(1);
    expect(s.totalWords).toBe(700);
  });

  it('totalWords 取最新记录日（不是今日快照的字段拼接）', () => {
    const days: DailyStat[] = [
      { date: '2026-08-01', words: 100 },
      { date: '2026-08-09', words: 3456 },
    ];
    expect(summarize(days, TODAY).totalWords).toBe(3456);
  });

  it('空记录：全零 + 今日未记录', () => {
    const s = summarize([], TODAY);
    expect(s).toEqual({ todayWords: null, todayDelta: null, weekAvg: 0, totalDays: 0, totalWords: 0 });
  });

  it('weekAvg 向下取整（不四舍五入）', () => {
    const days: DailyStat[] = [
      { date: addDays(TODAY, -1), words: 0 },
      { date: TODAY, words: 6 }, // delta 6 → 6/7=0.857 → 0
    ];
    expect(summarize(days, TODAY).weekAvg).toBe(0);
  });
});
