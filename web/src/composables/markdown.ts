import type { TicketView } from "@shared/protocol/contract.ts";
import {
  type BlockquoteNode,
  type CheckboxInputNode,
  type CheckboxNode,
  type CodeBlockNode,
  type EmphasisNode,
  getMarkdown,
  type HardBreakNode,
  type HeadingNode,
  type HtmlBlockNode,
  type HtmlInlineNode,
  type ImageNode,
  type InlineCodeNode,
  type LinkNode,
  type ListItemNode,
  type ListNode,
  type MarkdownIt,
  type ParagraphNode,
  type ParsedNode,
  parseMarkdownToStructure,
  type StrikethroughNode,
  type StrongNode,
  type TableCellNode,
  type TableNode,
  type TextNode,
  type ThematicBreakNode,
} from "stream-markdown-parser";
import type { InjectionKey } from "vue";

/**
 * Messages are parsed by stream-markdown-parser, then narrowed to the few shapes the panel draws.
 * Anything else degrades to its text, so a model can't make the panel render HTML or an odd link.
 */
export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "ticket"; ticketId: string; label: string }
  | { type: "break" }
  | { type: "caret" };

type Cell = { align?: "left" | "center" | "right"; children: Inline[] };

type ListItem = { checked?: boolean; children: Block[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "list"; ordered: boolean; start?: number; items: ListItem[] }
  | { type: "code"; language: string; code: string }
  | { type: "quote"; children: Block[] }
  | { type: "table"; head: Cell[]; rows: Cell[][] }
  | { type: "rule" };

/** The tickets a message can point at, and how to open one; provided by MarkdownText. */
type TicketLinks = {
  tickets: () => readonly TicketView[] | undefined;
  open: (ticketId: string) => void;
};
export const TICKET_LINKS: InjectionKey<TicketLinks> = Symbol("ticket-links");

const createMarkdown = (): MarkdownIt =>
  getMarkdown("eevee", {
    markdownItOptions: { html: false, typographer: false },
    enableMath: false,
    enableContainers: false,
  });

const settled = createMarkdown();

/**
 * Returns a parser for one message. A streaming message keeps its own markdown-it instance, whose
 * stream cache parses each append incrementally and holds unclosed syntax open; a settled one
 * shares a plain parse.
 */
export function markdownParser(): (source: string, streaming?: boolean) => Block[] {
  let stream: MarkdownIt | undefined;
  return (source, streaming = false) => {
    if (!streaming) return blocks(parseMarkdownToStructure(source, settled, { final: true }));
    stream ??= createMarkdown();
    return withCaret(blocks(parseMarkdownToStructure(source, stream, { final: false })));
  };
}

export const parseMarkdown = (source: string): Block[] => markdownParser()(source);

/** The parser's nodes this module reads; everything else falls back to its text. */
type Known =
  | TextNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | CodeBlockNode
  | InlineCodeNode
  | LinkNode
  | ImageNode
  | ThematicBreakNode
  | BlockquoteNode
  | TableNode
  | StrongNode
  | EmphasisNode
  | StrikethroughNode
  | HardBreakNode
  | HtmlBlockNode
  | HtmlInlineNode
  | CheckboxNode
  | CheckboxInputNode;

type Loose = { children?: unknown; content?: unknown; raw?: unknown };

function blocks(nodes: readonly ParsedNode[]): Block[] {
  const out: Block[] = [];
  let loose: ParsedNode[] = [];
  const flush = () => {
    if (loose.length > 0) out.push(paragraph(loose));
    loose = [];
  };
  for (const node of nodes) {
    const block = toBlock(node);
    if (block === undefined) {
      loose.push(node);
    } else {
      flush();
      out.push(...block);
    }
  }
  flush();
  return out;
}

/** The blocks a node becomes, or undefined when it is inline content. */
function toBlock(node: ParsedNode): Block[] | undefined {
  const known = node as Known;
  switch (known.type) {
    case "paragraph":
      return [paragraph(known.children)];
    case "heading":
      return [
        {
          type: "heading",
          level: Math.min(Math.max(known.level, 1), 6),
          children: trim(inlines(known.children)),
        },
      ];
    case "list":
      return [
        {
          type: "list",
          ordered: known.ordered,
          ...(known.ordered && known.start !== undefined && known.start !== 1
            ? { start: known.start }
            : {}),
          items: known.items.map(listItem),
        },
      ];
    case "code_block":
      // A closed fence ends its code with a newline; an open one, still streaming, does not.
      return [{ type: "code", language: known.language, code: known.code.replace(/\n$/, "") }];
    case "blockquote":
      return [{ type: "quote", children: blocks(known.children) }];
    case "table":
      return [
        {
          type: "table",
          head: known.header.cells.map(cell),
          rows: known.rows.map((row) => row.cells.map(cell)),
        },
      ];
    case "thematic_break":
      return [{ type: "rule" }];
    case "html_block":
      return [{ type: "paragraph", children: words(known.content, true) }];
  }
  // A container this module doesn't know (a footnote, say) still shows what it holds.
  const { children } = node as Loose;
  if (Array.isArray(children) && children.length > 0) return blocks(children);
  return undefined;
}

function paragraph(nodes: readonly ParsedNode[]): Block {
  return { type: "paragraph", children: trim(inlines(nodes)) };
}

function listItem(item: ListItemNode): ListItem {
  const [first, ...rest] = item.children;
  const box = first?.type === "paragraph" ? (first as ParagraphNode).children[0] : undefined;
  if (box?.type !== "checkbox_input" && box?.type !== "checkbox") {
    return { children: blocks(item.children) };
  }
  const label = {
    ...(first as ParagraphNode),
    children: (first as ParagraphNode).children.slice(1),
  };
  return {
    checked: (box as CheckboxInputNode | CheckboxNode).checked,
    children: blocks([label, ...rest]),
  };
}

function cell(node: TableCellNode): Cell {
  return { ...(node.align ? { align: node.align } : {}), children: trim(inlines(node.children)) };
}

function inlines(nodes: readonly ParsedNode[], refs = true): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) push(out, toInline(node, refs));
  return out;
}

function toInline(node: ParsedNode, refs: boolean): Inline[] {
  const known = node as Known;
  switch (known.type) {
    case "text":
      return words(known.content, refs);
    case "inline_code":
      return [{ type: "code", text: known.code }];
    case "strong":
    case "emphasis":
    case "strikethrough": {
      const children = inlines(known.children, refs);
      // `**t2**` is how models stress a ticket; the reference already stands out.
      if (children.length === 1 && children[0]?.type === "ticket") return children;
      return [{ type: MARK[known.type], children }];
    }
    case "link":
      return link(known);
    case "image":
      return WEB.test(known.src)
        ? [{ type: "link", href: known.src, children: words(known.alt || known.src, false) }]
        : words(known.alt, false);
    case "hardbreak":
      return [{ type: "break" }];
    case "html_inline":
    case "html_block":
      return words(known.content, refs);
    case "checkbox":
    case "checkbox_input":
      return [];
  }
  const { children, content, raw } = node as Loose;
  if (Array.isArray(children)) return inlines(children, refs);
  if (typeof content === "string") return words(content, refs);
  return typeof raw === "string" ? words(raw, refs) : [];
}

const MARK = { strong: "strong", emphasis: "em", strikethrough: "del" } as const;
const WEB = /^(?:https?:|mailto:)/i;
const TICKET_HREF = /^ticket:\/\/(t[1-9]\d*)$/i;
/** A ticket id standing on its own: not part of a word or of another address (`report://t2#1`). */
const TICKET = /(?<![\w/#:.-])(?:ticket:\/\/)?(t[1-9]\d*)(?![\w#/-])/gi;

function link(node: LinkNode): Inline[] {
  const ticketId = TICKET_HREF.exec(node.href)?.[1]?.toLowerCase();
  if (ticketId !== undefined) {
    const label = node.text !== "" && node.text !== node.href ? node.text : ticketId;
    return [{ type: "ticket", ticketId, label }];
  }
  const children = inlines(node.children, false);
  return WEB.test(node.href) ? [{ type: "link", href: node.href, children }] : children;
}

/** Plain text, with line breaks kept and ticket ids (`t3`, `ticket://t3`) made references. */
function words(text: string, refs: boolean): Inline[] {
  const out: Inline[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) out.push({ type: "break" });
    let last = 0;
    for (const match of refs ? line.matchAll(TICKET) : []) {
      const ticketId = match[1]?.toLowerCase() ?? "";
      push(out, [
        { type: "text", text: line.slice(last, match.index) },
        { type: "ticket", ticketId, label: ticketId },
      ]);
      last = match.index + match[0].length;
    }
    push(out, [{ type: "text", text: line.slice(last) }]);
  }
  return out;
}

function push(out: Inline[], items: readonly Inline[]): void {
  for (const item of items) {
    if (item.type !== "text") {
      out.push(item);
      continue;
    }
    if (item.text === "") continue;
    const prev = out.at(-1);
    if (prev?.type === "text") out[out.length - 1] = { type: "text", text: prev.text + item.text };
    else out.push(item);
  }
}

/** Drops the whitespace a block's markup leaves at its edges (`- [ ] task`). */
function trim(items: Inline[]): Inline[] {
  const first = items[0];
  if (first?.type === "text") items[0] = { type: "text", text: first.text.trimStart() };
  const last = items.at(-1);
  if (last?.type === "text") items[items.length - 1] = { type: "text", text: last.text.trimEnd() };
  return items.filter((item) => item.type !== "text" || item.text !== "");
}

/** Puts the streaming caret where the next words will appear. */
function withCaret(list: Block[]): Block[] {
  const last = list.at(-1);
  if (last?.type === "paragraph" || last?.type === "heading") {
    return [...list.slice(0, -1), { ...last, children: [...last.children, { type: "caret" }] }];
  }
  if (last?.type === "quote")
    return [...list.slice(0, -1), { ...last, children: withCaret(last.children) }];
  if (last?.type === "list") {
    const item = last.items.at(-1);
    if (item !== undefined) {
      const items = [...last.items.slice(0, -1), { ...item, children: withCaret(item.children) }];
      return [...list.slice(0, -1), { ...last, items }];
    }
  }
  return [...list, { type: "paragraph", children: [{ type: "caret" }] }];
}
