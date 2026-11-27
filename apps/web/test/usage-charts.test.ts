import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DailyUsageBucket } from "@eevee/protocol";
import { buildDailySeries, buildHeatmapGrid, buildMonthlySeries } from "../src/lib/usage-charts.ts";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

const SAMPLE: readonly DailyUsageBucket[] = [
  {
    date: "2026-11-15",
    input: 2000,
    output: 500,
    cacheRead: 4000,
    cacheWrite: 100,
    totalTokens: 6600,
    cost: 0.045,
    turns: 4,
  },
  {
    date: "2026-11-12",
    input: 1000,
    output: 200,
    cacheRead: 500,
    cacheWrite: 0,
    totalTokens: 1700,
    cost: 0.012,
    turns: 2,
  },
  {
    date: "2026-10-05",
    input: 400,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 500,
    cost: 0.005,
    turns: 1,
  },
];

describe("usage-charts", () => {
  it("builds contiguous 14-day daily series ending at today", () => {
    const series = buildDailySeries(SAMPLE, 14, NOW);
    assert.equal(series.length, 14);
    assert.equal(series[series.length - 1]?.key, "2026-11-15");
    assert.equal(series[series.length - 1]?.totalTokens, 6600);
    assert.equal(series[series.length - 4]?.key, "2026-11-12");
    assert.equal(series[series.length - 4]?.turns, 2);
    assert.equal(series[0]?.totalTokens, 0);
  });

  it("aggregates monthly series across months", () => {
    const series = buildMonthlySeries(SAMPLE, 6, NOW);
    assert.equal(series.length, 6);
    const nov = series.find((p) => p.key === "2026-11");
    const oct = series.find((p) => p.key === "2026-10");
    assert.equal(nov?.totalTokens, 8300);
    assert.equal(nov?.turns, 6);
    assert.equal(oct?.totalTokens, 500);
  });

  it("assigns relative intensity levels 0..4 on heatmap grid", () => {
    const cells = buildHeatmapGrid(SAMPLE, 12, NOW);
    const peak = cells.find((c) => c.date === "2026-11-15");
    const mid = cells.find((c) => c.date === "2026-11-12");
    const empty = cells.find((c) => c.date === "2026-11-14");
    assert.equal(peak?.level, 4);
    assert.equal(mid?.level, 2);
    assert.equal(empty?.level, 0);
  });
});
