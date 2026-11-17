export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "tref"; ticketId: string; label: string };

export type MarkdownBlock =
  | { kind: "paragraph"; inlines: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "code"; lang?: string; text: string };

const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|ticket:\/\/t[1-9]\d*\b|\bt[1-9]\d*\b)/g;

export function parseInlines(text: string, allowStrong = true): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ kind: "text", text: text.slice(last, index) });
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push({ kind: "code", text: token.slice(1, -1) });
    } else if (allowStrong && token.startsWith("**") && token.endsWith("**")) {
      const inner = token.slice(2, -2);
      if (/^t[1-9]\d*$/.test(inner)) {
        nodes.push({ kind: "tref", ticketId: inner, label: inner });
      } else {
        nodes.push({ kind: "strong", children: parseInlines(inner, false) });
      }
    } else if (token.startsWith("ticket://")) {
      const ticketId = token.slice("ticket://".length);
      nodes.push({ kind: "tref", ticketId, label: token });
    } else {
      nodes.push({ kind: "tref", ticketId: token, label: token });
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push({ kind: "text", text: text.slice(last) });
  return nodes;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const normalized = source.replaceAll("\r\n", "\n").trim();
  if (normalized === "") return [];
  const blocks: MarkdownBlock[] = [];
  const lines = normalized.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({
        kind: "code",
        ...(lang ? { lang } : {}),
        text: codeLines.join("\n"),
      });
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[-*] /.test(lines[i] ?? "")) {
        items.push(parseInlines((lines[i] ?? "").slice(2)));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? "")) {
        items.push(parseInlines((lines[i] ?? "").replace(/^\d+\. /, "")));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").startsWith("```") &&
      !/^[-*] /.test(lines[i] ?? "") &&
      !/^\d+\. /.test(lines[i] ?? "")
    ) {
      paraLines.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ kind: "paragraph", inlines: parseInlines(paraLines.join("\n")) });
  }

  return blocks;
}
