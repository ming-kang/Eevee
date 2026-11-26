import {
  Blockquote,
  CodeSnippet,
  CopyButton,
  Emphasis,
  Heading,
  InlineCode,
  Link,
  List,
  Prose,
  Separator,
  Strong,
  Table,
  Text,
} from "@earendil-works/elanor-react";
import { common, createLowlight } from "lowlight";
import { marked, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode, useMemo } from "react";

const lowlight = createLowlight(common);
const LANG_ALIASES: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mts: "typescript",
  cts: "typescript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  jsonc: "json",
  py: "python",
};

type HastNode = {
  readonly type: string;
  readonly value?: string;
  readonly properties?: { readonly className?: readonly string[] };
  readonly children?: readonly HastNode[];
};

function resolveLanguage(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const raw = hint.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const key = LANG_ALIASES[raw] ?? raw;
  return key && lowlight.registered(key) ? key : undefined;
}

function renderHast(nodes: readonly HastNode[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${index}`;
    if (node.type === "text") return node.value ?? "";
    const className = Array.isArray(node.properties?.className)
      ? node.properties.className.join(" ")
      : undefined;
    return (
      <span key={key} className={className}>
        {renderHast(node.children ?? [], key)}
      </span>
    );
  });
}

function highlightCode(code: string, lang: string | undefined): ReactNode {
  const language = resolveLanguage(lang);
  if (!language || code.length > 80_000) return code;
  try {
    const tree = lowlight.highlight(language, code);
    return renderHast(tree.children as unknown as readonly HastNode[], "hl");
  } catch {
    return code;
  }
}

function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (/^(?:https?:|mailto:|#)/i.test(trimmed)) return trimmed;
  return undefined;
}

function renderInline(tokens: readonly Token[] | undefined, prefix: string): ReactNode {
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token, index) => {
    const key = `${prefix}.${index}`;
    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        return textToken.tokens ? (
          <Fragment key={key}>{renderInline(textToken.tokens, key)}</Fragment>
        ) : (
          textToken.text
        );
      }
      case "escape":
        return (token as Tokens.Escape).text;
      case "strong":
        return <Strong key={key}>{renderInline((token as Tokens.Strong).tokens, key)}</Strong>;
      case "em":
        return <Emphasis key={key}>{renderInline((token as Tokens.Em).tokens, key)}</Emphasis>;
      case "del":
        return <del key={key}>{renderInline((token as Tokens.Del).tokens, key)}</del>;
      case "codespan":
        return <InlineCode key={key}>{(token as Tokens.Codespan).text}</InlineCode>;
      case "br":
        return <br key={key} />;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        if (!href) return <Fragment key={key}>{renderInline(link.tokens, key)}</Fragment>;
        return (
          <Link key={key} href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(link.tokens, key)}
          </Link>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = safeHref(image.href);
        const label = image.text || image.href;
        return href ? (
          <Link key={key} href={href} target="_blank" rel="noreferrer noopener">
            [{label}]
          </Link>
        ) : (
          `[${label}]`
        );
      }
      case "html":
        return (token as Tokens.HTML).text;
      default:
        return "raw" in token && typeof token.raw === "string" ? token.raw : null;
    }
  });
}

function CodeBlock({ code, lang }: { readonly code: string; readonly lang?: string }) {
  const highlighted = useMemo(() => highlightCode(code, lang), [code, lang]);
  return (
    <CodeSnippet
      actions={<CopyButton value={code} aria-label="复制代码" />}
      data-language={lang || undefined}
    >
      {highlighted}
    </CodeSnippet>
  );
}

function alignment(
  align: "center" | "left" | "right" | null | undefined,
): "start" | "center" | "end" {
  if (align === "center") return "center";
  if (align === "right") return "end";
  return "start";
}

function renderBlocks(tokens: readonly Token[], prefix: string): ReactNode {
  return tokens.map((token, index) => {
    const key = `${prefix}.${index}`;
    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        const level = Math.min(6, Math.max(3, heading.depth + 2)) as 3 | 4 | 5 | 6;
        return (
          <Heading key={key} level={level} variant="app" size={level <= 4 ? 5 : 6}>
            {renderInline(heading.tokens, key)}
          </Heading>
        );
      }
      case "paragraph": {
        const para = token as Tokens.Paragraph;
        return <Text key={key}>{renderInline(para.tokens, key)}</Text>;
      }
      case "text": {
        const textToken = token as Tokens.Text;
        return (
          <Text key={key}>
            {textToken.tokens ? renderInline(textToken.tokens, key) : textToken.text}
          </Text>
        );
      }
      case "code": {
        const code = token as Tokens.Code;
        return <CodeBlock key={key} code={code.text} lang={code.lang} />;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        return <Blockquote key={key}>{renderBlocks(quote.tokens, key)}</Blockquote>;
      }
      case "hr":
        return <Separator key={key} />;
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIdx) => {
          const itemKey = `${key}.li.${itemIdx}`;
          const prefixMark = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
          return (
            <List.Item key={itemKey}>
              {prefixMark}
              {renderBlocks(item.tokens, itemKey)}
            </List.Item>
          );
        });
        return list.ordered ? (
          <List.Root key={key} render={<ol start={list.start || 1} />}>
            {items}
          </List.Root>
        ) : (
          <List.Root key={key}>{items}</List.Root>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        const headerKeys = table.header.map((cell) => `${key}.th.${cell.text}`);
        return (
          <Table.Container key={key}>
            <Table.Root>
              <Table.Head>
                <Table.Row>
                  {table.header.map((cell, cellIdx) => {
                    const cellKey = `${headerKeys[cellIdx] ?? cell.text}#${cell.tokens.length}`;
                    return (
                      <Table.HeaderCell
                        key={cellKey}
                        scope="col"
                        align={alignment(table.align[cellIdx])}
                      >
                        {renderInline(cell.tokens, cellKey)}
                      </Table.HeaderCell>
                    );
                  })}
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {table.rows.map((row) => {
                  const rowKey = `${key}.tr.${row.map((c) => c.text).join("|")}`;
                  return (
                    <Table.Row key={rowKey}>
                      {row.map((cell, cellIdx) => {
                        const cellKey = `${rowKey}.${headerKeys[cellIdx] ?? cell.text}`;
                        return (
                          <Table.Cell key={cellKey} align={alignment(table.align[cellIdx])}>
                            {renderInline(cell.tokens, cellKey)}
                          </Table.Cell>
                        );
                      })}
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Table.Container>
        );
      }
      case "html":
        return (
          <pre key={key} className="eevee-pre">
            {(token as Tokens.HTML).text}
          </pre>
        );
      default:
        return "raw" in token && typeof token.raw === "string" ? (
          <Text key={key}>{token.raw}</Text>
        ) : null;
    }
  });
}

export function Markdown({
  text,
  streaming = false,
}: {
  readonly text: string;
  readonly streaming?: boolean;
}) {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true, breaks: false }), [text]);
  return (
    <Prose className="eevee-markdown">
      {renderBlocks(tokens, "md")}
      {streaming && <span className="eevee-streaming-dot" role="status" aria-label="生成中" />}
    </Prose>
  );
}
