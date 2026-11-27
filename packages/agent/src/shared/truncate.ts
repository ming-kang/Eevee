export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export type TruncationResult = {
  readonly content: string;
  readonly truncated: boolean;
  readonly truncatedBy: "lines" | "bytes" | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
};

export type TruncateOptions = {
  readonly maxLines?: number;
  readonly maxBytes?: number;
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let index = 0; index < lines.length && index < maxLines; index++) {
    const line = lines[index];
    if (line === undefined) break;
    const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }

  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(output, "utf8"),
  };
}

export function truncateTail(content: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index--) {
    const line = lines[index];
    if (line === undefined) break;
    const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (kept.length === 0) {
        kept.push(utf8TailClip(line, maxBytes));
      }
      break;
    }
    kept.unshift(line);
    bytes += lineBytes;
  }

  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(output, "utf8"),
  };
}

const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

function utf8SequenceLength(lead: number): number {
  return lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
}

export function alignUtf8Start(bytes: Uint8Array, index: number): number {
  let aligned = Math.max(0, Math.floor(index));
  while (
    aligned < bytes.length &&
    ((bytes[aligned] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS
  ) {
    aligned += 1;
  }
  return aligned;
}

export function alignUtf8End(bytes: Uint8Array, index: number): number {
  const bound = Math.min(bytes.length, Math.floor(index));
  if (bound <= 0) return 0;
  let lead = bound - 1;
  while (lead > 0 && ((bytes[lead] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) {
    lead -= 1;
  }
  return lead + utf8SequenceLength(bytes[lead] ?? 0) <= bound ? bound : lead;
}

export function utf8HeadBytes(text: string, maxBytes: number): Buffer {
  if (!(maxBytes > 0)) return Buffer.alloc(0);
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return buf;
  return buf.subarray(0, alignUtf8End(buf, maxBytes));
}

export function utf8HeadClip(text: string, maxBytes: number): string {
  if (!(maxBytes > 0)) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, alignUtf8End(buf, maxBytes)).toString("utf8");
}

export function utf8TailClip(text: string, maxBytes: number): string {
  if (!(maxBytes > 0)) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(alignUtf8Start(buf, buf.length - maxBytes)).toString("utf8");
}

export const GREP_MAX_LINE_LENGTH = 500;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export function sliceHead(text: string, maxUnits: number): string {
  const end = Math.max(0, maxUnits);
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? text.slice(0, end - 1)
    : text.slice(0, end);
}

export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${sliceHead(line, maxChars)}... [truncated]`, wasTruncated: true };
}
