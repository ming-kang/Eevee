import { open } from "node:fs/promises";
import { errorMessage } from "../../shared/guards.ts";
import { alignUtf8End, alignUtf8Start, utf8HeadClip, utf8TailClip } from "../../shared/truncate.ts";

export const TASK_READ_MIN_BYTES = 256;
export const TASK_READ_DEFAULT_BYTES = 8 * 1024;
export const TASK_READ_MAX_BYTES = 48 * 1024;
export const MAX_FILTER_SCAN_BYTES = 20 * 1024 * 1024;
export const TASK_FILTER_MAX_CONTEXT_LINES = 5;

const FILTER_CHUNK_BYTES = 64 * 1024;

export function clampReadBytes(bytes?: number): number {
  if (bytes === undefined || !Number.isFinite(bytes)) return TASK_READ_DEFAULT_BYTES;
  return Math.min(TASK_READ_MAX_BYTES, Math.max(TASK_READ_MIN_BYTES, Math.floor(bytes)));
}

export type OutputSlice = {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly fromByte: number;
  readonly endByte: number;
  readonly matchedLines?: number;
  readonly totalMatchedLines?: number;
  readonly scanTruncated?: boolean;
};

export type OutputReadOptions = {
  readonly mode?: "head" | "tail";
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly endByte?: number;
  readonly filter?: string;
  readonly contextLines?: number;
};

type OutputWindow = {
  readonly mode: "head" | "tail";
  readonly floor: number;
  readonly ceiling: number;
  readonly start: number;
  readonly end: number;
};

function outputBounds(
  size: number,
  options: OutputReadOptions,
): { readonly mode: "head" | "tail"; readonly floor: number; readonly ceiling: number } {
  const mode = options.mode ?? "tail";
  const ceiling =
    options.endByte !== undefined && Number.isFinite(options.endByte)
      ? Math.min(size, Math.max(0, Math.floor(options.endByte)))
      : size;
  const since =
    options.sinceBytes !== undefined && Number.isFinite(options.sinceBytes)
      ? options.sinceBytes
      : undefined;
  const floor = since === undefined || since > ceiling ? 0 : Math.max(0, Math.floor(since));
  return { mode, floor, ceiling };
}

function outputWindow(size: number, options: OutputReadOptions): OutputWindow {
  const { mode, floor, ceiling } = outputBounds(size, options);
  const bytes = clampReadBytes(options.bytes);
  const start =
    mode === "head"
      ? options.sinceBytes !== undefined
        ? floor
        : 0
      : Math.max(floor, ceiling - bytes);
  const end = mode === "head" ? Math.min(start + bytes, ceiling) : ceiling;
  return { mode, floor, ceiling, start, end };
}

function buildLineMatcher(rawFilter: string): (line: string) => boolean {
  const regexMatch = /^\/(.+)\/([dgimsuvy]*)$/.exec(rawFilter);
  if (regexMatch !== null) {
    const pattern = regexMatch[1] ?? "";
    const flags = regexMatch[2] ?? "";
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Invalid filter regular expression: ${errorMessage(error)}`);
    }
    const stateless = new RegExp(pattern, flags.replace(/[gy]/g, ""));
    return (line) => stateless.test(line);
  }
  const needle = rawFilter.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

export function validateOutputReadOptions(
  options: OutputReadOptions = {},
): ((line: string) => boolean) | undefined {
  const hasFilter = options.filter !== undefined && options.filter !== "";
  if (options.contextLines !== undefined) {
    if (!hasFilter) {
      throw new Error("contextLines requires filter");
    }
    if (
      !Number.isInteger(options.contextLines) ||
      options.contextLines < 0 ||
      options.contextLines > TASK_FILTER_MAX_CONTEXT_LINES
    ) {
      throw new Error(
        `Invalid contextLines: must be an integer between 0 and ${TASK_FILTER_MAX_CONTEXT_LINES}`,
      );
    }
  }
  return hasFilter ? buildLineMatcher(options.filter as string) : undefined;
}

function createFilterCollector(
  matcher: (line: string) => boolean,
  maxBytes: number,
  mode: "head" | "tail",
  contextLines: number,
) {
  const ring: Array<{ readonly lineNo: number; readonly text: string }> = [];
  const rows: Array<{ readonly text: string; readonly isMatch: boolean }> = [];
  let rowsBytes = 0;
  let keptMatchedLines = 0;
  let totalMatchedLines = 0;
  let outputClamped = false;
  let lastEmittedLine = 0;
  let trailingContext = 0;
  let lineNo = 0;
  let headFull = false;

  const pushRow = (text: string, isMatch: boolean) => {
    if (mode === "head") {
      const rowBytes = Buffer.byteLength(text, "utf8") + (rows.length > 0 ? 1 : 0);
      if (rowsBytes + rowBytes > maxBytes) {
        if (rows.length === 0 && maxBytes > 0) {
          const clipped = utf8HeadClip(text, maxBytes);
          rows.push({ text: clipped, isMatch });
          rowsBytes = Buffer.byteLength(clipped, "utf8");
          if (isMatch) keptMatchedLines += 1;
        }
        outputClamped = true;
        headFull = true;
        return;
      }
      rows.push({ text, isMatch });
      rowsBytes += rowBytes;
      if (isMatch) keptMatchedLines += 1;
      return;
    }

    let rowText = text;
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      outputClamped = true;
      rowText = utf8TailClip(text, maxBytes);
    }
    const rowBytes = Buffer.byteLength(rowText, "utf8") + (rows.length > 0 ? 1 : 0);
    rows.push({ text: rowText, isMatch });
    rowsBytes += rowBytes;
    if (isMatch) keptMatchedLines += 1;
    while (rows.length > 1 && rowsBytes > maxBytes) {
      const dropped = rows.shift();
      if (dropped === undefined) break;
      rowsBytes -= Buffer.byteLength(dropped.text, "utf8") + 1;
      if (dropped.isMatch) keptMatchedLines -= 1;
      outputClamped = true;
    }
    while (rows[0]?.text === "--") {
      rows.shift();
      rowsBytes = rows.length === 0 ? 0 : rowsBytes - 3;
    }
  };

  const emitEntry = (num: number, sep: ":" | "-", text: string, isMatch: boolean) => {
    if (num <= lastEmittedLine) return;
    if (
      contextLines > 0 &&
      lastEmittedLine > 0 &&
      num > lastEmittedLine + 1 &&
      rows.length > 0 &&
      !headFull
    ) {
      pushRow("--", false);
    }
    if (headFull) return;
    pushRow(`${num}${sep} ${text}`, isMatch);
    lastEmittedLine = num;
  };

  const feedLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    lineNo += 1;
    if (matcher(line)) {
      totalMatchedLines += 1;
      if (!headFull) {
        for (const before of ring) emitEntry(before.lineNo, "-", before.text, false);
        emitEntry(lineNo, ":", line, true);
        trailingContext = contextLines;
      }
    } else if (trailingContext > 0 && !headFull) {
      emitEntry(lineNo, "-", line, false);
      trailingContext -= 1;
    }
    if (contextLines > 0 && !headFull) {
      ring.push({ lineNo, text: line });
      if (ring.length > contextLines) ring.shift();
    }
  };

  return {
    feedLine,
    finish(
      totalBytes: number,
      fromByte: number,
      endByte: number,
      scanTruncated: boolean,
    ): OutputSlice {
      return {
        text: rows.map((row) => row.text).join("\n"),
        totalBytes,
        truncated: outputClamped || scanTruncated || endByte < totalBytes,
        fromByte,
        endByte,
        matchedLines: keptMatchedLines,
        totalMatchedLines,
        scanTruncated,
      };
    },
  };
}

function filterBounds(
  size: number,
  options: OutputReadOptions,
): {
  readonly mode: "head" | "tail";
  readonly floor: number;
  readonly ceiling: number;
  readonly scanStart: number;
  readonly scanEnd: number;
  readonly scanTruncated: boolean;
} {
  const { mode, floor, ceiling } = outputBounds(size, options);
  const span = Math.max(0, ceiling - floor);
  if (span <= MAX_FILTER_SCAN_BYTES) {
    return {
      mode,
      floor,
      ceiling,
      scanStart: floor,
      scanEnd: ceiling,
      scanTruncated: false,
    };
  }
  if (mode === "head") {
    return {
      mode,
      floor,
      ceiling,
      scanStart: floor,
      scanEnd: floor + MAX_FILTER_SCAN_BYTES,
      scanTruncated: true,
    };
  }
  return {
    mode,
    floor,
    ceiling,
    scanStart: ceiling - MAX_FILTER_SCAN_BYTES,
    scanEnd: ceiling,
    scanTruncated: true,
  };
}

export type ByteRangeSource = {
  readonly totalBytes: number;
  readonly availableStart?: number;
  readonly availableEnd?: number;
  readRange(start: number, end: number): Uint8Array | Promise<Uint8Array>;
};

type SlicePlan =
  | {
      readonly kind: "window";
      readonly window: OutputWindow;
      readonly lo: number;
      readonly hi: number;
      readonly availableStart: number;
      readonly availableEnd: number;
      readonly totalBytes: number;
    }
  | {
      readonly kind: "filter";
      readonly matcher: (line: string) => boolean;
      readonly bounds: ReturnType<typeof filterBounds>;
      readonly lo: number;
      readonly hi: number;
      readonly availableStart: number;
      readonly availableEnd: number;
      readonly totalBytes: number;
      readonly scanTruncated: boolean;
      readonly maxBytes: number;
      readonly contextLines: number;
    };

function planByteRangeSlice(
  source: Pick<ByteRangeSource, "totalBytes" | "availableStart" | "availableEnd">,
  options: OutputReadOptions,
): SlicePlan {
  const matcher = validateOutputReadOptions(options);
  const availableStart = source.availableStart ?? 0;
  const availableEnd = source.availableEnd ?? source.totalBytes;
  if (matcher !== undefined) {
    const bounds = filterBounds(source.totalBytes, options);
    const lo = Math.max(bounds.scanStart, availableStart);
    const hi = Math.max(lo, Math.min(bounds.scanEnd, availableEnd));
    return {
      kind: "filter",
      matcher,
      bounds,
      lo,
      hi,
      availableStart,
      availableEnd,
      totalBytes: source.totalBytes,
      scanTruncated: bounds.scanTruncated || bounds.scanStart < availableStart,
      maxBytes: clampReadBytes(options.bytes),
      contextLines: options.contextLines ?? 0,
    };
  }
  const window = outputWindow(source.totalBytes, options);
  const lo = Math.max(window.start, availableStart);
  const hi = Math.max(lo, Math.min(window.end, availableEnd));
  return {
    kind: "window",
    window,
    lo,
    hi,
    availableStart,
    availableEnd,
    totalBytes: source.totalBytes,
  };
}

function finalizeWindowSlice(
  data: Uint8Array,
  plan: Extract<SlicePlan, { readonly kind: "window" }>,
): OutputSlice {
  const rangeEnd = plan.lo + data.length;
  const start = plan.lo <= plan.availableStart ? 0 : alignUtf8Start(data, 0);
  let end = rangeEnd >= plan.availableEnd ? data.length : alignUtf8End(data, data.length);
  if (end < start) end = start;
  const endByte = plan.lo + end;
  const truncated =
    plan.window.start < plan.availableStart ||
    (plan.window.mode !== "head" && plan.window.start > plan.window.floor) ||
    endByte < plan.totalBytes;
  return {
    text: Buffer.from(data.subarray(start, end)).toString("utf8"),
    totalBytes: plan.totalBytes,
    truncated,
    fromByte: plan.lo + start,
    endByte,
  };
}

function createFilterScanner(plan: Extract<SlicePlan, { readonly kind: "filter" }>) {
  const collector = createFilterCollector(
    plan.matcher,
    plan.maxBytes,
    plan.bounds.mode,
    plan.contextLines,
  );
  const decoder = new TextDecoder();
  let pos = plan.lo;
  let actualStart = plan.lo;
  let actualEnd = plan.lo;
  let firstChunk = true;
  let pending = "";

  const pushChunk = (chunk: Uint8Array) => {
    if (chunk.length === 0) return;
    let view = chunk;
    if (firstChunk) {
      firstChunk = false;
      if (pos > plan.availableStart) {
        const offset = alignUtf8Start(view, 0);
        if (offset > 0) {
          actualStart += offset;
          view = view.subarray(offset);
        }
      }
    }
    pos += chunk.length;
    if (pos >= plan.hi && plan.hi < plan.availableEnd) {
      const aligned = alignUtf8End(view, view.length);
      actualEnd = pos - (view.length - aligned);
      view = view.subarray(0, aligned);
    } else {
      actualEnd = pos;
    }
    pending += decoder.decode(view, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      collector.feedLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  };

  const finish = (): OutputSlice => {
    pending += decoder.decode();
    if (pending.length > 0) collector.feedLine(pending);
    return collector.finish(plan.totalBytes, actualStart, actualEnd, plan.scanTruncated);
  };

  return { pushChunk, finish };
}

export function sliceRetainedOutput(
  retained: Uint8Array,
  fromByte: number,
  totalBytes: number,
  options: OutputReadOptions = {},
): OutputSlice {
  const plan = planByteRangeSlice(
    { totalBytes, availableStart: fromByte, availableEnd: fromByte + retained.length },
    options,
  );
  const readSync = (start: number, end: number) =>
    retained.subarray(start - fromByte, end - fromByte);
  if (plan.kind === "window") {
    return finalizeWindowSlice(
      plan.hi > plan.lo ? readSync(plan.lo, plan.hi) : new Uint8Array(0),
      plan,
    );
  }
  const scanner = createFilterScanner(plan);
  if (plan.hi > plan.lo) {
    scanner.pushChunk(readSync(plan.lo, plan.hi));
  }
  return scanner.finish();
}

export function sliceOutputText(text: string, options: OutputReadOptions = {}): OutputSlice {
  const bytes = Buffer.from(text, "utf8");
  return sliceRetainedOutput(bytes, 0, bytes.length, options);
}

export function utf8Tail(text: string, maxBytes: number): { text: string; fromByte: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, fromByte: 0 };
  if (!(maxBytes > 0)) return { text: "", fromByte: bytes.length };
  const start = alignUtf8Start(bytes, bytes.length - maxBytes);
  return { text: bytes.subarray(start).toString("utf8"), fromByte: start };
}

export async function sliceByteRange(
  source: ByteRangeSource,
  options: OutputReadOptions = {},
): Promise<OutputSlice> {
  const plan = planByteRangeSlice(source, options);
  if (plan.kind === "window") {
    const data = plan.hi > plan.lo ? await source.readRange(plan.lo, plan.hi) : new Uint8Array(0);
    return finalizeWindowSlice(data, plan);
  }
  const scanner = createFilterScanner(plan);
  let pos = plan.lo;
  while (pos < plan.hi) {
    const nextEnd = Math.min(plan.hi, pos + FILTER_CHUNK_BYTES);
    const chunk = await source.readRange(pos, nextEnd);
    if (chunk.length === 0) break;
    scanner.pushChunk(chunk);
    pos += chunk.length;
  }
  return scanner.finish();
}

export async function readOutputFileSlice(
  filePath: string,
  options: OutputReadOptions = {},
): Promise<OutputSlice> {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    return await sliceByteRange(
      {
        totalBytes: size,
        readRange: async (start, end) => {
          const length = Math.max(0, end - start);
          if (length === 0) return new Uint8Array(0);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, start);
          return buffer.subarray(0, bytesRead);
        },
      },
      options,
    );
  } finally {
    await handle.close();
  }
}
