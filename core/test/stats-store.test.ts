import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StatsStore, previousDailyStat } from '../src/stats-store.js';

describe('StatsStore', () => {
  it('同日覆盖、按日期排序并隔离 workDir', () => {
    const store = new StatsStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'stats-')), 'x.sqlite'));
    try {
      store.upsert('/a', '2024-02-02', 20);
      store.upsert('/a', '2024-01-01', 10);
      store.upsert('/a', '2024-02-02', 25);
      store.upsert('/b', '2024-01-01', 99);
      expect(store.list('/a')).toEqual([{ date: '2024-01-01', words: 10 }, { date: '2024-02-02', words: 25 }]);
      expect(store.list('/b')).toEqual([{ date: '2024-01-01', words: 99 }]);
    } finally { store.close(); }
  });

  it('取严格早于目标日期的最后记录，不依赖目标日期已落行', () => {
    const days = [
      { date: '2024-01-01', words: 10 },
      { date: '2024-01-03', words: 30 },
      { date: '2024-01-05', words: 50 },
    ];
    expect(previousDailyStat(days, '2024-01-04')).toEqual({ date: '2024-01-03', words: 30 });
    expect(previousDailyStat(days, '2024-01-05')).toEqual({ date: '2024-01-03', words: 30 });
    expect(previousDailyStat(days, '2024-01-01')).toBeNull();
  });
});
