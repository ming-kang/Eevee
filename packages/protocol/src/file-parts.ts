export const MAX_MESSAGE_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_FILE_CHARS = 100_000;

export type FilePartRef = {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly path?: string;
};

export type FilePartSource = {
  readonly name?: string;
  readonly mimeType: string;
  readonly data: string;
  readonly size: number;
  readonly path?: string;
};

const FILE_PART_HEAD = /^<file name="([^"]*)"(?: path="([^"]*)")? type="([^"]*)" size="(\d+)">/;

export function parseFilePart(text: string): FilePartRef | undefined {
  const match = FILE_PART_HEAD.exec(text);
  if (match === null) return undefined;
  const [, name, path, mimeType, size] = match;
  return {
    name: name ?? "",
    mimeType: mimeType ?? "",
    size: Number(size),
    ...(path === undefined ? {} : { path }),
  };
}

export function filePartInner(text: string): string | undefined {
  const match = FILE_PART_HEAD.exec(text);
  if (match === null || !text.endsWith("</file>")) return undefined;
  const inner = text.slice(match[0].length, -"</file>".length);
  return inner.startsWith("\n") && inner.endsWith("\n") ? inner.slice(1, -1) : inner;
}

export function filePartText(part: FilePartSource): string {
  const path = part.path === undefined ? "" : ` path="${cleanAttr(part.path)}"`;
  const head = `<file name="${cleanAttr(part.name)}"${path} type="${cleanAttr(part.mimeType)}" size="${part.size}">`;
  if (part.size > MAX_ATTACHMENT_BYTES) {
    return `${head}[content not included — the file is too large]</file>`;
  }
  const decoded = decodeUtf8Base64(part.data);
  if (decoded === undefined) {
    return `${head}[binary file — content not included]</file>`;
  }
  if (decoded.length <= MAX_INLINE_FILE_CHARS) {
    return `${head}\n${decoded}\n</file>`;
  }
  return `${head}\n${decoded.slice(0, MAX_INLINE_FILE_CHARS)}\n[…truncated — ${part.size} bytes total]\n</file>`;
}

function cleanAttr(value: string | undefined): string {
  const clean = (value ?? "file").replace(/["\r\n]/g, " ").trim();
  return clean === "" ? "file" : clean;
}

function decodeUtf8Base64(base64: string): string | undefined {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
