import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatClockTime,
  formatDurationMs,
  formatElapsedSeconds,
  formatRelativeTime,
  formatWorkingClock,
} from "./time.ts";

test("relative time supports long and short forms", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 20_000, now, "long"), "now");
  assert.equal(formatRelativeTime(now - 20_000, now, "short"), "now");
  assert.equal(formatRelativeTime(now - 3 * 60_000, now, "long"), "3 min ago");
  assert.equal(formatRelativeTime(now - 3 * 60_000, now, "short"), "3m");
  assert.equal(formatRelativeTime(now - 5 * 3600_000, now, "long"), "5 h ago");
  assert.equal(formatRelativeTime(now - 5 * 3600_000, now, "short"), "5h");
  assert.equal(formatRelativeTime(now - 3 * 86400_000, now, "long"), "3 d ago");
  assert.equal(formatRelativeTime(now - 3 * 86400_000, now, "short"), "3d");
  assert.equal(formatRelativeTime(now - 14 * 86400_000, now, "long"), "2 wk ago");
  assert.equal(formatRelativeTime(now - 14 * 86400_000, now, "short"), "2w");
});

test("clock time, milliseconds and seconds formatting", () => {
  const sameDay = new Date(2026, 10, 17, 9, 5, 0).getTime();
  const prevDay = new Date(2026, 10, 14, 18, 30, 0).getTime();
  assert.equal(formatClockTime(sameDay, sameDay + 60_000), "09:05");
  assert.equal(formatClockTime(prevDay, sameDay), "11/14 18:30");
  assert.equal(formatDurationMs(420), "420ms");
  assert.equal(formatDurationMs(2340), "2.3s");
  assert.equal(formatElapsedSeconds(125), "2:05");
  assert.equal(formatElapsedSeconds(3661), "1:01:01");
});

test("fixed timestamps render compact minute, hour, day and week units", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  const minute = 60_000;
  for (const [age, expected] of [
    [8 * minute, "8m"],
    [8 * 60 * minute, "8h"],
    [3 * 24 * 60 * minute, "3d"],
    [8 * 7 * 24 * 60 * minute, "8w"],
  ] as const) {
    assert.equal(formatRelativeTime(now - age, now, "short"), expected);
  }
});

test("the working clock reads m:ss, h:mm:ss past an hour, never below 0:01", () => {
  assert.equal(formatWorkingClock(0), "0:01");
  assert.equal(formatWorkingClock(0.4), "0:01");
  assert.equal(formatWorkingClock(83), "1:23");
  assert.equal(formatWorkingClock(3725), "1:02:05");
});
