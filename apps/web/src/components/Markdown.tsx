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
import { type MarkedToken, marked, type Token } from "marked";
import { Fragment, type ReactNode, useMemo } from "react";
import { useI18n } from "../lib/i18n.ts";

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

const MARKED_TOKEN_TYPES: ReadonlySet<string> = new Set<MarkedToken["type"]>([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);

function isMarkedToken(token: Token): token is MarkedToken {
  return MARKED_TOKEN_TYPES.has(token.type);
}

type HastChildren = ReturnType<typeof lowlight.highlight>["children"];

function resolveLanguage(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const raw = hint.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const key = LANG_ALIASES[raw] ?? raw;
  return key && lowlight.registered(key) ? key : undefined;
}

function renderHast(nodes: HastChildren, prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${index}`;
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const rawCls = node.properties?.className;
    const className = Array.isArray(rawCls)
      ? rawCls.filter((c): c is string => typeof c === "string").join(" ")
      : undefined;
    return (
      <span key={key} className={className}>
        {renderHast(node.children, key)}
      </span>
    );
  });
}

function highlightCode(code: string, lang: string | undefined): ReactNode {
  const language = resolveLanguage(lang);
  if (!language || code.length > 80_000) return code;
  try {
    const tree = lowlight.highlight(language, code);
    return renderHast(tree.children, "hl");
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
    if (!isMarkedToken(token)) return token.raw;
    switch (token.type) {
      case "text":
        return token.tokens ? (
          <Fragment key={key}>{renderInline(token.tokens, key)}</Fragment>
        ) : (
          token.text
        );
      case "escape":
        return token.text;
      case "strong":
        return <Strong key={key}>{renderInline(token.tokens, key)}</Strong>;
      case "em":
        return <Emphasis key={key}>{renderInline(token.tokens, key)}</Emphasis>;
      case "del":
        return <del key={key}>{renderInline(token.tokens, key)}</del>;
      case "codespan":
        return <InlineCode key={key}>{token.text}</InlineCode>;
      case "br":
        return <br key={key} />;
      case "link": {
        const href = safeHref(token.href);
        if (!href) return <Fragment key={key}>{renderInline(token.tokens, key)}</Fragment>;
        return (
          <Link key={key} href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(token.tokens, key)}
          </Link>
        );
      }
      case "image": {
        const href = safeHref(token.href);
        const label = token.text || token.href;
        return href ? (
          <Link key={key} href={href} target="_blank" rel="noreferrer noopener">
            [{label}]
          </Link>
        ) : (
          `[${label}]`
        );
      }
      case "html":
        return token.text;
      default:
        return token.raw;
    }
  });
}

function CodeBlock({ code, lang }: { readonly code: string; readonly lang?: string }) {
  const { t } = useI18n();
  const highlighted = useMemo(() => highlightCode(code, lang), [code, lang]);
  return (
    <CodeSnippet
      actions={<CopyButton value={code} aria-label={t("transcript.copyCode")} />}
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
    if (!isMarkedToken(token)) return <Text key={key}>{token.raw}</Text>;
    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        const level = Math.min(6, Math.max(3, token.depth + 2)) as 3 | 4 | 5 | 6;
        return (
          <Heading key={key} level={level} variant="app" size={level <= 4 ? 5 : 6}>
            {renderInline(token.tokens, key)}
          </Heading>
        );
      }
      case "paragraph":
        return <Text key={key}>{renderInline(token.tokens, key)}</Text>;
      case "text":
        return <Text key={key}>{token.tokens ? renderInline(token.tokens, key) : token.text}</Text>;
      case "code":
        return <CodeBlock key={key} code={token.text} lang={token.lang} />;
      case "blockquote":
        return <Blockquote key={key}>{renderBlocks(token.tokens, key)}</Blockquote>;
      case "hr":
        return <Separator key={key} />;
      case "list": {
        const items = token.items.map((item, itemIdx) => {
          const itemKey = `${key}.li.${itemIdx}`;
          const prefixMark = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
          return (
            <List.Item key={itemKey}>
              {prefixMark}
              {renderBlocks(item.tokens, itemKey)}
            </List.Item>
          );
        });
        return token.ordered ? (
          <List.Root key={key} render={<ol start={token.start || 1} />}>
            {items}
          </List.Root>
        ) : (
          <List.Root key={key}>{items}</List.Root>
        );
      }
      case "table": {
        const headerKeys = token.header.map((cell) => `${key}.th.${cell.text}`);
        return (
          <Table.Container key={key}>
            <Table.Root>
              <Table.Head>
                <Table.Row>
                  {token.header.map((cell, cellIdx) => {
                    const cellKey = `${headerKeys[cellIdx] ?? cell.text}#${cell.tokens.length}`;
                    return (
                      <Table.HeaderCell
                        key={cellKey}
                        scope="col"
                        align={alignment(token.align[cellIdx])}
                      >
                        {renderInline(cell.tokens, cellKey)}
                      </Table.HeaderCell>
                    );
                  })}
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {token.rows.map((row) => {
                  const rowKey = `${key}.tr.${row.map((c) => c.text).join("|")}`;
                  return (
                    <Table.Row key={rowKey}>
                      {row.map((cell, cellIdx) => {
                        const cellKey = `${rowKey}.${headerKeys[cellIdx] ?? cell.text}`;
                        return (
                          <Table.Cell key={cellKey} align={alignment(token.align[cellIdx])}>
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
          <pre key={key} className="ev-pre">
            {token.text}
          </pre>
        );
      default:
        return <Text key={key}>{token.raw}</Text>;
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
  const { t } = useI18n();
  const tokens = useMemo(() => marked.lexer(text, { gfm: true, breaks: false }), [text]);
  return (
    <Prose className="eevee-markdown">
      {renderBlocks(tokens, "md")}
      {streaming && (
        <span
          className="eevee-streaming-dot"
          role="status"
          aria-label={t("transcript.generating")}
        />
      )}
    </Prose>
  );
}
