const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff],
  [0x2e80, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
];

const BREAKS = ["; ", "；", "。", ". ", "！", "？", "! ", "? ", "，", ", "];

function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high);
}

export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    if (isWide(char)) wide++;
    else narrow++;
  }
  return wide + Math.ceil(narrow / 4);
}

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function fitTokens(text: string, limit: number): string {
  if (estimateTokens(text) <= limit) return text;
  const maxBody = Math.max(0, limit - 1);
  let wide = 0;
  let narrow = 0;
  let end = 0;
  for (const char of text) {
    const nextWide = isWide(char) ? wide + 1 : wide;
    const nextNarrow = isWide(char) ? narrow : narrow + 1;
    if (nextWide + Math.ceil(nextNarrow / 4) > maxBody) break;
    wide = nextWide;
    narrow = nextNarrow;
    end += char.length;
  }
  const head = text.slice(0, end);
  let cut = -1;
  for (const mark of BREAKS) {
    const found = head.lastIndexOf(mark);
    if (found !== -1) cut = Math.max(cut, found + mark.length);
  }
  return `${(cut >= head.length / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

export function clipMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.max(0, Math.floor(limit / 2));
  return `${text.slice(0, half)}\n…[${text.length - 2 * half} characters omitted]…\n${half === 0 ? "" : text.slice(-half)}`;
}
