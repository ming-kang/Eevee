import type { DailyUsageBucket } from "@eevee/protocol";

export type UsageBarSeriesPoint = {
  readonly key: string;
  readonly label: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cost: number;
  readonly totalTokens: number;
  readonly turns: number;
};

export type HeatmapCell = {
  readonly date: string;
  readonly totalTokens: number;
  readonly cost: number;
  readonly turns: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly weekIndex: number;
  readonly dayOfWeek: number;
};

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function buildDailySeries(
  buckets: readonly DailyUsageBucket[],
  days = 14,
  nowMs = Date.now(),
): UsageBarSeriesPoint[] {
  const byDate = new Map(buckets.map((b) => [b.date, b]));
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  const out: UsageBarSeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = formatDateUtc(d);
    const found = byDate.get(key);
    out.push({
      key,
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      input: found?.input ?? 0,
      output: found?.output ?? 0,
      cacheRead: found?.cacheRead ?? 0,
      cost: found?.cost ?? 0,
      totalTokens: found?.totalTokens ?? 0,
      turns: found?.turns ?? 0,
    });
  }
  return out;
}

export function buildMonthlySeries(
  buckets: readonly DailyUsageBucket[],
  months = 6,
  nowMs = Date.now(),
): UsageBarSeriesPoint[] {
  const byMonth = new Map<
    string,
    {
      input: number;
      output: number;
      cacheRead: number;
      cost: number;
      totalTokens: number;
      turns: number;
    }
  >();
  for (const b of buckets) {
    const monthKey = b.date.slice(0, 7);
    const cur = byMonth.get(monthKey) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cost: 0,
      totalTokens: 0,
      turns: 0,
    };
    cur.input += b.input;
    cur.output += b.output;
    cur.cacheRead += b.cacheRead;
    cur.cost += b.cost;
    cur.totalTokens += b.totalTokens;
    cur.turns += b.turns;
    byMonth.set(monthKey, cur);
  }

  const now = new Date(nowMs);
  const baseYear = now.getUTCFullYear();
  const baseMonth = now.getUTCMonth();
  const out: UsageBarSeriesPoint[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(baseYear, baseMonth - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const found = byMonth.get(key);
    out.push({
      key,
      label: key.slice(2),
      input: found?.input ?? 0,
      output: found?.output ?? 0,
      cacheRead: found?.cacheRead ?? 0,
      cost: found?.cost ?? 0,
      totalTokens: found?.totalTokens ?? 0,
      turns: found?.turns ?? 0,
    });
  }
  return out;
}

export function buildHeatmapGrid(
  buckets: readonly DailyUsageBucket[],
  weeks = 16,
  nowMs = Date.now(),
): HeatmapCell[] {
  const byDate = new Map(buckets.map((b) => [b.date, b]));
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  const endDow = today.getUTCDay();
  const totalDays = (weeks - 1) * 7 + endDow + 1;
  const startMs = today.getTime() - (totalDays - 1) * 86_400_000;

  let maxTokens = 0;
  const raw: {
    date: string;
    totalTokens: number;
    cost: number;
    turns: number;
    weekIndex: number;
    dayOfWeek: number;
  }[] = [];

  for (let i = 0; i < totalDays; i += 1) {
    const d = new Date(startMs + i * 86_400_000);
    const date = formatDateUtc(d);
    const found = byDate.get(date);
    const totalTokens = found?.totalTokens ?? 0;
    if (totalTokens > maxTokens) maxTokens = totalTokens;
    raw.push({
      date,
      totalTokens,
      cost: found?.cost ?? 0,
      turns: found?.turns ?? 0,
      weekIndex: Math.floor(i / 7),
      dayOfWeek: d.getUTCDay(),
    });
  }

  return raw.map((cell) => {
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (cell.totalTokens > 0 && maxTokens > 0) {
      const ratio = cell.totalTokens / maxTokens;
      if (ratio >= 0.75) level = 4;
      else if (ratio >= 0.45) level = 3;
      else if (ratio >= 0.18) level = 2;
      else level = 1;
    }
    return { ...cell, level };
  });
}
