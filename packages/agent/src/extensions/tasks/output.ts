import { open } from "node:fs/promises";

export const TASK_READ_MIN_BYTES = 256;
export const TASK_READ_DEFAULT_BYTES = 8 * 1024;
export const TASK_READ_MAX_BYTES = 48 * 1024;

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
};

export type OutputReadOptions = {
  readonly mode?: "head" | "tail";
  readonly bytes?: number;
  readonly sinceBytes?: number;
};

type OutputWindow = {
  readonly mode: "head" | "tail";
  readonly floor: number;
  readonly start: number;
  readonly end: number;
};

function outputWindow(size: number, options: OutputReadOptions): OutputWindow {
  const mode = options.mode ?? "tail";
  const bytes = clampReadBytes(options.bytes);
  const since =
    options.sinceBytes !== undefined && Number.isFinite(options.sinceBytes)
      ? options.sinceBytes
      : undefined;
  const floor = since === undefined || since > size ? 0 : Math.max(0, Math.floor(since));
  const start = mode === "head" ? (since !== undefined ? floor : 0) : Math.max(floor, size - bytes);
  const end = mode === "head" ? Math.min(start + bytes, size) : size;
  return { mode, floor, start, end };
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
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
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
