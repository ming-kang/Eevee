export type ColumnKind = "number" | "code" | "short" | "text";

export function classifyColumn(cells: readonly string[]): ColumnKind {
  const nonEmpty = cells.map((c) => c.trim()).filter((c) => c.length > 0);
  if (nonEmpty.length === 0) return "short";

  const numRe = /^[+-]?([$€£¥]?\d[\d,_]*(\.\d+)?%?|\d+(\.\d+)?\s*(ms|s|m|h|k|M|B|KB|MB|GB|px|%)?)$/;
  if (nonEmpty.every((c) => numRe.test(c) || c === "—" || c === "-" || c === "N/A")) {
    return "number";
  }

  const codeRe = /^`[^`]+`$|^(?=.*[./_:@-])[A-Za-z0-9_./:@-]+$/;
  if (nonEmpty.every((c) => c.length <= 44 && codeRe.test(c))) {
    return "code";
  }

  const maxLen = nonEmpty.reduce((m, c) => Math.max(m, c.length), 0);
  return maxLen <= 18 ? "short" : "text";
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function tableToCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return lines.join("\n");
}

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function tableToMarkdown(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  aligns?: readonly ("left" | "center" | "right" | null | undefined)[],
): string {
  const headerLine = `| ${headers.map(escapeMdCell).join(" | ")} |`;
  const sepCells = headers.map((_, idx) => {
    const a = aligns?.[idx];
    if (a === "right") return "---:";
    if (a === "center") return ":---:";
    return "---";
  });
  const sepLine = `| ${sepCells.join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.map(escapeMdCell).join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type MarkdownHeading = {
  readonly id: string;
  readonly depth: 1 | 2 | 3;
  readonly text: string;
};

export function slugifyHeading(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return `h-${index}-${base || "section"}`;
}
