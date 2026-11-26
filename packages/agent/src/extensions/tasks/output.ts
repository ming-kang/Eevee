import { open } from "node:fs/promises";

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

const CONTINUATION = 0x80;

function utf8SequenceLength(lead: number): number {
  return lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
}

/** First index at or after `index` that does not continue a multi-byte sequence. */
function alignStart(bytes: Uint8Array, index: number): number {
  let aligned = index;
  while (aligned < bytes.length && ((bytes[aligned] ?? 0) & 0xc0) === CONTINUATION) aligned += 1;
  return aligned;
}

/** Last index at or before `index` on a codepoint boundary. */
function alignEnd(bytes: Uint8Array, index: number): number {
  if (index <= 0) return 0;
  let lead = index - 1;
  while (lead > 0 && ((bytes[lead] ?? 0) & 0xc0) === CONTINUATION) lead -= 1;
  return lead + utf8SequenceLength(bytes[lead] ?? 0) <= index ? index : lead;
}

function utf8HeadClip(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, alignEnd(buf, maxBytes)).toString("utf8");
}

function utf8TailClip(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(alignStart(buf, buf.length - maxBytes)).toString("utf8");
}

function buildLineMatcher(rawFilter: string): (line: string) => boolean {
  const regexMatch = /^\/(.+)\/([dgimsuvy]*)$/.exec(rawFilter);
  if (regexMatch !== null) {
    const pattern = regexMatch[1] ?? "";
    const flags = regexMatch[2] ?? "";
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(
        `Invalid filter regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
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

/**
 * Slice `retained`, which covers bytes `[fromByte, fromByte + retained.length)` of a stream
 * `totalBytes` long, to the requested window on codepoint boundaries.
 */
export function sliceRetainedOutput(
  retained: Uint8Array,
  fromByte: number,
  totalBytes: number,
  options: OutputReadOptions = {},
): OutputSlice {
  const matcher = validateOutputReadOptions(options);
  if (matcher !== undefined) {
    const bounds = filterBounds(totalBytes, options);
    const retainedEnd = fromByte + retained.length;
    const lo = Math.max(bounds.scanStart, fromByte);
    const hi = Math.min(bounds.scanEnd, retainedEnd);
    const start = lo <= fromByte ? 0 : alignStart(retained, lo - fromByte);
    let end = hi >= retainedEnd ? retained.length : alignEnd(retained, hi - fromByte);
    if (end < start) end = start;
    const actualStart = fromByte + start;
    const actualEnd = fromByte + end;
    const scanTruncated = bounds.scanTruncated || bounds.scanStart < fromByte;
    const collector = createFilterCollector(
      matcher,
      clampReadBytes(options.bytes),
      bounds.mode,
      options.contextLines ?? 0,
    );
    const text = Buffer.from(retained.subarray(start, end)).toString("utf8");
    if (text.length > 0) {
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const line of lines) collector.feedLine(line);
    }
    return collector.finish(totalBytes, actualStart, actualEnd, scanTruncated);
  }

  const window = outputWindow(totalBytes, options);
  const retainedEnd = fromByte + retained.length;
  const lo = Math.max(window.start, fromByte);
  const hi = Math.min(window.end, retainedEnd);
  const start = lo <= fromByte ? 0 : alignStart(retained, lo - fromByte);
  let end = hi >= retainedEnd ? retained.length : alignEnd(retained, hi - fromByte);
  if (end < start) end = start;
  const endByte = fromByte + end;
  const truncated =
    window.start < fromByte ||
    (window.mode !== "head" && window.start > window.floor) ||
    endByte < totalBytes;
  return {
    text: Buffer.from(retained.subarray(start, end)).toString("utf8"),
    totalBytes,
    truncated,
    fromByte: fromByte + start,
    endByte,
  };
}

export function sliceOutputText(text: string, options: OutputReadOptions = {}): OutputSlice {
  const bytes = Buffer.from(text, "utf8");
  return sliceRetainedOutput(bytes, 0, bytes.length, options);
}

/** The last `maxBytes` of `text` on a codepoint boundary, and its byte offset within `text`. */
export function utf8Tail(text: string, maxBytes: number): { text: string; fromByte: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, fromByte: 0 };
  const start = alignStart(bytes, bytes.length - maxBytes);
  return { text: bytes.subarray(start).toString("utf8"), fromByte: start };
}

export async function readOutputFileSlice(
  filePath: string,
  options: OutputReadOptions = {},
): Promise<OutputSlice> {
  const matcher = validateOutputReadOptions(options);
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    if (matcher !== undefined) {
      const bounds = filterBounds(size, options);
      const collector = createFilterCollector(
        matcher,
        clampReadBytes(options.bytes),
        bounds.mode,
        options.contextLines ?? 0,
      );
      if (bounds.scanEnd <= bounds.scanStart) {
        return collector.finish(size, bounds.scanStart, bounds.scanStart, bounds.scanTruncated);
      }
      const chunk = Buffer.alloc(FILTER_CHUNK_BYTES);
      const decoder = new TextDecoder();
      let pos = bounds.scanStart;
      let actualStart = bounds.scanStart;
      let firstChunk = true;
      let pending = "";
      while (pos < bounds.scanEnd) {
        const toRead = Math.min(chunk.length, bounds.scanEnd - pos);
        const { bytesRead } = await handle.read(chunk, 0, toRead, pos);
        if (bytesRead <= 0) break;
        let view = chunk.subarray(0, bytesRead);
        if (firstChunk) {
          firstChunk = false;
          if (pos > 0) {
            const offset = alignStart(view, 0);
            if (offset > 0) {
              actualStart += offset;
              view = view.subarray(offset);
            }
          }
        }
        pos += bytesRead;
        pending += decoder.decode(view, { stream: true });
        let nl = pending.indexOf("\n");
        while (nl !== -1) {
          collector.feedLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      }
      pending += decoder.decode();
      if (pending.length > 0) collector.feedLine(pending);
      return collector.finish(size, actualStart, pos, bounds.scanTruncated);
    }

    const window = outputWindow(size, options);
    const length = Math.max(0, window.end - window.start);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, window.start);
    const data = buffer.subarray(0, bytesRead);
    const start = alignStart(data, 0);
    const end = Math.max(start, alignEnd(data, data.length));
    const endByte = window.start + end;
    const truncated = (window.mode !== "head" && window.start > window.floor) || endByte < size;
    return {
      text: data.subarray(start, end).toString("utf8"),
      totalBytes: size,
      truncated,
      fromByte: window.start + start,
      endByte,
    };
  } finally {
    await handle.close();
  }
}
