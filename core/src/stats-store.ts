import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_stats (
  work_dir TEXT NOT NULL,
  date TEXT NOT NULL,
  words INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (work_dir, date)
);
`;

export interface DailyStat {
  date: string;
  words: number;
}

interface DbDailyStat {
  date: string;
  words: number;
}

export class StatsStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 2000;');
    db.exec(SCHEMA);
    this.db = db;
  }

  upsert(workDir: string, date: string, words: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO daily_stats (work_dir, date, words, updated_at) VALUES (?, ?, ?, ?)'
    ).run(workDir, date, words, new Date().toISOString());
  }

  list(workDir: string): DailyStat[] {
    const rows = this.db.prepare(
      'SELECT date, words FROM daily_stats WHERE work_dir = ? ORDER BY date ASC'
    ).all(workDir) as unknown as DbDailyStat[];
    return rows.map((row) => ({ date: row.date, words: Number(row.words) }));
  }

  close(): void {
    this.db.close();
  }
}

export function previousDailyStat(days: DailyStat[], date: string): DailyStat | null {
  let previous: DailyStat | null = null;
  for (const day of days) {
    if (day.date >= date) break;
    previous = day;
  }
  return previous;
}
