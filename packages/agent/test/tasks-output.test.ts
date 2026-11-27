import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type BackgroundTaskRecord,
  describeTaskOutcome,
  isTaskActiveStatus,
  isTaskTerminalStatus,
  MAX_FILTER_SCAN_BYTES,
  readOutputFileSlice,
  resolveTaskId,
  sliceOutputText,
  sliceRetainedOutput,
} from "../src/extensions/tasks/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-tasks-output-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("task status predicates and describeTaskOutcome handle all 8 statuses", () => {
  const active: BackgroundTaskRecord["status"][] = ["queued", "running", "stopping"];
  const terminal: BackgroundTaskRecord["status"][] = [
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
  ];
  for (const status of active) {
    assert.equal(isTaskActiveStatus(status), true);
    assert.equal(isTaskTerminalStatus(status), false);
  }
  for (const status of terminal) {
    assert.equal(isTaskActiveStatus(status), false);
    assert.equal(isTaskTerminalStatus(status), true);
  }

  const base = { id: "task-1", command: "cmd", startedAt: 1 };
  assert.equal(describeTaskOutcome({ ...base, status: "queued" }), "queued");
  assert.equal(describeTaskOutcome({ ...base, status: "running" }), "running");
  assert.equal(describeTaskOutcome({ ...base, status: "stopping" }), "stopping");
  assert.equal(
    describeTaskOutcome({ ...base, status: "completed", exitCode: 0 }),
    "completed with code 0",
  );
  assert.equal(describeTaskOutcome({ ...base, status: "completed" }), "completed");
  assert.equal(
    describeTaskOutcome({ ...base, status: "failed", exitCode: 2 }),
    "failed with code 2",
  );
  assert.equal(describeTaskOutcome({ ...base, status: "failed", error: "boom" }), "failed: boom");
  assert.equal(
    describeTaskOutcome({ ...base, status: "timed_out", error: "timeout:5" }),
    "timed out after 5s",
  );
  assert.equal(describeTaskOutcome({ ...base, status: "cancelled" }), "cancelled");
  assert.equal(
    describeTaskOutcome({ ...base, status: "cancelled", cancelReason: "user" }),
    "cancelled by user",
  );
  assert.equal(
    describeTaskOutcome({ ...base, status: "interrupted", error: "Interrupted by host restart" }),
    "Interrupted by host restart",
  );
});

test("resolveTaskId resolves exact, case-insensitive, prefix, suffix, ambiguous, and not_found", () => {
  const records: BackgroundTaskRecord[] = [
    { id: "task-1", command: "echo 1", status: "completed", startedAt: 1 },
    { id: "task-2", command: "echo 2", status: "running", startedAt: 2 },
    { id: "task-10", command: "echo 10", status: "running", startedAt: 3 },
  ];

  assert.deepEqual(resolveTaskId(records, "task-1"), { kind: "match", record: records[0] });
  assert.deepEqual(resolveTaskId(records, "TASK-2"), { kind: "match", record: records[1] });
  assert.deepEqual(resolveTaskId(records, "2"), { kind: "match", record: records[1] });
  assert.deepEqual(resolveTaskId(records, "10"), { kind: "match", record: records[2] });
  assert.deepEqual(resolveTaskId(records, "task-2"), { kind: "match", record: records[1] });

  const ambiguousSuffix = resolveTaskId(records, "1");
  assert.equal(ambiguousSuffix.kind, "ambiguous");
  if (ambiguousSuffix.kind === "ambiguous") {
    assert.deepEqual(
      ambiguousSuffix.matches.map((m) => m.id),
      ["task-1", "task-10"],
    );
  }

  const ambiguousPrefix = resolveTaskId(records, "task-");
  assert.equal(ambiguousPrefix.kind, "ambiguous");
  assert.deepEqual(resolveTaskId(records, "task-99"), { kind: "not_found" });
  assert.deepEqual(resolveTaskId(records, "  "), { kind: "not_found" });
});

test("endByte backward paging walks multi-byte UTF-8 file cleanly without splitting codepoints", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "paging.log");
    const content = `${"a".repeat(300)}€${"b".repeat(300)}`;
    await writeFile(file, content, "utf8");

    const page1 = await readOutputFileSlice(file, { mode: "tail", bytes: 301 });
    assert.equal(page1.fromByte, 303);
    assert.equal(page1.endByte, 603);
    assert.equal(page1.text, "b".repeat(300));
    assert.equal(page1.truncated, true);

    const page2 = await readOutputFileSlice(file, {
      mode: "tail",
      bytes: 301,
      endByte: page1.fromByte,
    });
    assert.equal(page2.fromByte, 2);
    assert.equal(page2.endByte, 303);
    assert.equal(page2.text, `${"a".repeat(298)}€`);
    assert.equal(page2.truncated, true);

    const page3 = await readOutputFileSlice(file, {
      mode: "tail",
      bytes: 301,
      endByte: page2.fromByte,
    });
    assert.equal(page3.fromByte, 0);
    assert.equal(page3.endByte, 2);
    assert.equal(page3.text, "aa");
    assert.equal(page3.truncated, true);

    const empty = await readOutputFileSlice(file, { mode: "tail", bytes: 301, endByte: 0 });
    assert.equal(empty.fromByte, 0);
    assert.equal(empty.endByte, 0);
    assert.equal(empty.text, "");
  });
});

test("filter supports case-insensitive substrings, /regex/flags, and rejects invalid regexes", async () => {
  const sample = [
    "info: booting service",
    "WARN: cache cold",
    "error: failed to connect",
    "debug: /usr/bin/node started",
    "ERROR: timeout",
  ].join("\n");

  const sub = sliceOutputText(sample, { filter: "error" });
  assert.equal(sub.matchedLines, 2);
  assert.equal(sub.totalMatchedLines, 2);
  assert.equal(sub.scanTruncated, false);
  assert.equal(sub.truncated, false);
  assert.equal(sub.text, "3: error: failed to connect\n5: ERROR: timeout");

  const regexCaseSensitive = sliceOutputText(sample, { filter: "/ERROR:/" });
  assert.equal(regexCaseSensitive.matchedLines, 1);
  assert.equal(regexCaseSensitive.totalMatchedLines, 1);
  assert.equal(regexCaseSensitive.text, "5: ERROR: timeout");

  const regexGlobal = sliceOutputText(sample, { filter: "/error:/gi" });
  assert.equal(regexGlobal.matchedLines, 2);
  assert.equal(regexGlobal.totalMatchedLines, 2);

  const pathSub = sliceOutputText(sample, { filter: "/usr/bin/node" });
  assert.equal(pathSub.matchedLines, 1);
  assert.equal(pathSub.text, "4: debug: /usr/bin/node started");

  assert.throws(() => sliceOutputText(sample, { filter: "/[unclosed/i" }), /Invalid filter/);
  assert.throws(() => sliceOutputText(sample, { filter: "/abc/ii" }), /Invalid filter/);
});

test("contextLines validates 0..5, requires filter, merges overlaps, and uses -- between disjoint hunks", async () => {
  const lines = [
    "line 1",
    "hit A",
    "line 3",
    "hit B",
    "line 5",
    "line 6",
    "line 7",
    "line 8",
    "hit C",
    "line 10",
  ].join("\n");

  assert.throws(() => sliceOutputText(lines, { contextLines: 1 }), /contextLines requires filter/);
  assert.throws(() => sliceOutputText(lines, { contextLines: 0 }), /contextLines requires filter/);
  assert.throws(
    () => sliceOutputText(lines, { filter: "hit", contextLines: -1 }),
    /Invalid contextLines/,
  );
  assert.throws(
    () => sliceOutputText(lines, { filter: "hit", contextLines: 6 }),
    /Invalid contextLines/,
  );
  assert.throws(
    () => sliceOutputText(lines, { filter: "hit", contextLines: 1.5 }),
    /Invalid contextLines/,
  );

  const zeroCtx = sliceOutputText(lines, { filter: "hit", contextLines: 0 });
  assert.equal(zeroCtx.text, "2: hit A\n4: hit B\n9: hit C");
  assert.equal(zeroCtx.matchedLines, 3);
  assert.equal(zeroCtx.totalMatchedLines, 3);

  const oneCtx = sliceOutputText(lines, { filter: "hit", contextLines: 1 });
  assert.equal(
    oneCtx.text,
    [
      "1- line 1",
      "2: hit A",
      "3- line 3",
      "4: hit B",
      "5- line 5",
      "--",
      "8- line 8",
      "9: hit C",
      "10- line 10",
    ].join("\n"),
  );
  assert.equal(oneCtx.matchedLines, 3);
  assert.equal(oneCtx.totalMatchedLines, 3);

  await withTempDir(async (dir) => {
    const file = join(dir, "ctx.log");
    await writeFile(file, lines, "utf8");
    const fromFile = await readOutputFileSlice(file, { filter: "hit", contextLines: 1 });
    assert.equal(fromFile.text, oneCtx.text);
  });
});

test("filter clamps output to clampReadBytes in head and tail modes while reporting totalMatchedLines", () => {
  const many = Array.from(
    { length: 40 },
    (_, i) => `match-${String(i + 1).padStart(2, "0")}-${"x".repeat(30)}`,
  ).join("\n");
  const head = sliceOutputText(many, { filter: "match-", mode: "head", bytes: 256 });
  assert.equal(head.truncated, true);
  assert.equal(head.totalMatchedLines, 40);
  assert.ok((head.matchedLines ?? 0) > 0 && (head.matchedLines ?? 0) < 40);
  assert.ok(Buffer.byteLength(head.text, "utf8") <= 256);
  assert.ok(head.text.includes("1: match-01-"));

  const tail = sliceOutputText(many, { filter: "match-", mode: "tail", bytes: 256 });
  assert.equal(tail.truncated, true);
  assert.equal(tail.totalMatchedLines, 40);
  assert.ok((tail.matchedLines ?? 0) > 0 && (tail.matchedLines ?? 0) < 40);
  assert.ok(Buffer.byteLength(tail.text, "utf8") <= 256);
  assert.ok(tail.text.includes("40: match-40-"));

  const retained = sliceRetainedOutput(
    Buffer.from(many, "utf8"),
    100,
    100 + Buffer.byteLength(many),
    {
      filter: "match-",
      mode: "tail",
      bytes: 256,
    },
  );
  assert.equal(retained.totalMatchedLines, 40);
  assert.ok(retained.text.includes("40: match-40-"));
});

test("readOutputFileSlice caps filtered scan at MAX_FILTER_SCAN_BYTES (20 MiB) and sets scanTruncated", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "huge.log");
    const filler = Buffer.alloc(1024 * 1024, "a");
    filler[filler.length - 1] = 0x0a;

    const headMarker = Buffer.from("HEAD_NEEDLE\n", "utf8");
    const tailMarker = Buffer.from("TAIL_NEEDLE\n", "utf8");
    const parts: Buffer[] = [headMarker];
    for (let i = 0; i < 21; i += 1) {
      parts.push(filler);
    }
    parts.push(tailMarker);
    await writeFile(file, Buffer.concat(parts));

    const tailScan = await readOutputFileSlice(file, { filter: "NEEDLE", mode: "tail" });
    assert.equal(tailScan.scanTruncated, true);
    assert.equal(tailScan.truncated, true);
    assert.equal(tailScan.totalMatchedLines, 1);
    assert.ok(tailScan.text.includes("TAIL_NEEDLE"), tailScan.text);
    assert.equal(tailScan.text.includes("HEAD_NEEDLE"), false);
    assert.equal(tailScan.endByte, Buffer.concat(parts).length);
    assert.equal(tailScan.endByte - tailScan.fromByte, MAX_FILTER_SCAN_BYTES);

    const headScan = await readOutputFileSlice(file, { filter: "NEEDLE", mode: "head" });
    assert.equal(headScan.scanTruncated, true);
    assert.equal(headScan.truncated, true);
    assert.equal(headScan.totalMatchedLines, 1);
    assert.ok(headScan.text.includes("HEAD_NEEDLE"), headScan.text);
    assert.equal(headScan.text.includes("TAIL_NEEDLE"), false);
    assert.equal(headScan.fromByte, 0);
    assert.equal(headScan.endByte, MAX_FILTER_SCAN_BYTES);
  });
});
