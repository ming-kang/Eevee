import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatClockTime,
  formatDurationMs,
  formatElapsedSeconds,
  formatRelativeTime,
} from "./time.ts";

test("相对时间支持长短两种格式", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 20_000, now, "long"), "刚刚");
  assert.equal(formatRelativeTime(now - 20_000, now, "short"), "刚刚");
  assert.equal(formatRelativeTime(now - 3 * 60_000, now, "long"), "3 分钟前");
  assert.equal(formatRelativeTime(now - 3 * 60_000, now, "short"), "3分");
  assert.equal(formatRelativeTime(now - 5 * 3600_000, now, "long"), "5 小时前");
  assert.equal(formatRelativeTime(now - 5 * 3600_000, now, "short"), "5时");
  assert.equal(formatRelativeTime(now - 3 * 86400_000, now, "long"), "3 天前");
  assert.equal(formatRelativeTime(now - 3 * 86400_000, now, "short"), "3天");
  assert.equal(formatRelativeTime(now - 14 * 86400_000, now, "long"), "2 周前");
  assert.equal(formatRelativeTime(now - 14 * 86400_000, now, "short"), "2周");
});

test("时钟时间、毫秒与秒数格式化", () => {
  const sameDay = new Date(2026, 10, 17, 9, 5, 0).getTime();
  const prevDay = new Date(2026, 10, 14, 18, 30, 0).getTime();
  assert.equal(formatClockTime(sameDay, sameDay + 60_000), "09:05");
  assert.equal(formatClockTime(prevDay, sameDay), "11/14 18:30");
  assert.equal(formatDurationMs(420), "420ms");
  assert.equal(formatDurationMs(2340), "2.3s");
  assert.equal(formatElapsedSeconds(125), "2:05");
  assert.equal(formatElapsedSeconds(3661), "1:01:01");
});
