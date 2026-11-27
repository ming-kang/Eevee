import {
  CheckIcon,
  ContentCopyIcon,
  ExpandLessIcon,
  ExpandMoreIcon,
  WrapTextIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Blockquote,
  CopyButton,
  Emphasis,
  Heading,
  Link,
  List,
  Prose,
  Separator,
  Strong,
  Table,
  Text,
} from "@earendil-works/elanor-react";
import { common, createLowlight } from "lowlight";
import { type MarkedToken, marked, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import {
  classifyColumn,
  copyToClipboard,
  slugifyHeading,
  tableToCsv,
  tableToMarkdown,
} from "../lib/markdown-utils.ts";
import { showToast } from "../lib/toasts.ts";
import { EvTooltip } from "./EvTooltip.tsx";

const lowlight = createLowlight(common);
const COLLAPSE_LINE_THRESHOLD = 22;

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

function CopyableInlineCode({ text }: { readonly text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(async () => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    showToast(t("transcript.copied"));
    window.setTimeout(() => setCopied(false), 1200);
  }, [text, t]);

  return (
    <EvTooltip
      content={copied ? t("transcript.copied") : t("transcript.inlineCodeCopyTitle")}
      side="top"
    >
      <button
        type="button"
        className="ev-inline-code-btn"
        data-copied={copied || undefined}
        onClick={handleClick}
      >
        <code className="ev-inline-code-text">{text}</code>
        <span className="ev-inline-code-icon" aria-hidden="true">
          {copied ? (
            <CheckIcon width={11} height={11} />
          ) : (
            <ContentCopyIcon width={11} height={11} />
          )}
        </span>
      </button>
    </EvTooltip>
  );
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
        return <CopyableInlineCode key={key} text={token.text} />;
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

function CodeBlock({
  code,
  lang,
  streaming,
}: {
  readonly code: string;
  readonly lang?: string;
  readonly streaming: boolean;
}) {
  const { t } = useI18n();
  const [wrapped, setWrapped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lineCount = useMemo(() => (code ? code.split("\n").length : 0), [code]);
  const collapsible = !streaming && lineCount > COLLAPSE_LINE_THRESHOLD;
  const isCollapsed = collapsible && !expanded;
  const highlighted = useMemo(() => highlightCode(code, lang), [code, lang]);
  const displayLang = lang?.trim().split(/\s+/)[0] || undefined;

  return (
    <div
      className="ev-code-block"
      data-language={displayLang}
      data-wrapped={wrapped || undefined}
      data-collapsed={isCollapsed || undefined}
    >
      <div className="ev-code-head">
        <span className="ev-code-lang ev-mono">{displayLang ?? "code"}</span>
        <div className="ev-code-actions">
          <EvTooltip content={t("transcript.codeWrap")} side="top">
            <button
              type="button"
              className="ev-code-act-btn"
              aria-pressed={wrapped}
              aria-label={t("transcript.codeWrap")}
              onClick={() => setWrapped((prev) => !prev)}
            >
              <WrapTextIcon width={14} height={14} />
            </button>
          </EvTooltip>
          <CopyButton
            value={code}
            aria-label={t("transcript.copyCode")}
            className="ev-code-copy-btn"
          />
        </div>
      </div>

      <div className="ev-code-body">
        <pre className="ev-code-pre">
          <code>{highlighted}</code>
        </pre>
        {isCollapsed && <div className="ev-code-fade" aria-hidden="true" />}
      </div>

      {collapsible && (
        <button
          type="button"
          className="ev-code-expand-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? (
            <>
              <ExpandLessIcon width={15} height={15} />
              <span>{t("transcript.codeCollapse")}</span>
            </>
          ) : (
            <>
              <ExpandMoreIcon width={15} height={15} />
              <span>{t("transcript.codeExpand", { lines: lineCount })}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

function EditorialTable({
  token,
  tableKey,
}: {
  readonly token: Tokens.Table;
  readonly tableKey: string;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflowRight, setOverflowRight] = useState(false);
  const [copiedMode, setCopiedMode] = useState<"csv" | "md" | undefined>(undefined);

  const headerTexts = useMemo(() => token.header.map((c) => c.text), [token.header]);
  const rowTexts = useMemo(() => token.rows.map((row) => row.map((c) => c.text)), [token.rows]);
  const colKinds = useMemo(
    () => headerTexts.map((_, colIdx) => classifyColumn(rowTexts.map((r) => r[colIdx] ?? ""))),
    [headerTexts, rowTexts],
  );

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setOverflowRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 6);
  }, []);

  useEffect(() => {
    updateOverflow();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateOverflow]);

  const copyTable = useCallback(
    async (mode: "csv" | "md") => {
      const payload =
        mode === "csv"
          ? tableToCsv(headerTexts, rowTexts)
          : tableToMarkdown(headerTexts, rowTexts, token.align);
      const ok = await copyToClipboard(payload);
      if (!ok) return;
      setCopiedMode(mode);
      showToast(t("transcript.copied"));
      window.setTimeout(() => setCopiedMode(undefined), 1300);
    },
    [headerTexts, rowTexts, token.align, t],
  );

  const cellAlign = (colIdx: number): "start" | "center" | "end" => {
    const explicit = token.align[colIdx];
    if (explicit === "center") return "center";
    if (explicit === "right") return "end";
    if (explicit === "left") return "start";
    return colKinds[colIdx] === "number" ? "end" : "start";
  };

  const headerKeys = token.header.map((cell, idx) => `${tableKey}.th.${idx}.${cell.text}`);

  return (
    <div className="ev-table-wrap" data-overflow-right={overflowRight || undefined}>
      <div className="ev-table-tools">
        <EvTooltip content={t("transcript.tableCopyCsvTitle")} side="top">
          <button type="button" className="ev-table-copy-btn" onClick={() => copyTable("csv")}>
            {copiedMode === "csv" ? (
              <CheckIcon width={12} height={12} />
            ) : (
              <ContentCopyIcon width={12} height={12} />
            )}
            <span>{t("transcript.tableCopyCsv")}</span>
          </button>
        </EvTooltip>
        <EvTooltip content={t("transcript.tableCopyMdTitle")} side="top">
          <button type="button" className="ev-table-copy-btn" onClick={() => copyTable("md")}>
            {copiedMode === "md" ? (
              <CheckIcon width={12} height={12} />
            ) : (
              <ContentCopyIcon width={12} height={12} />
            )}
            <span>{t("transcript.tableCopyMd")}</span>
          </button>
        </EvTooltip>
      </div>

      <div ref={scrollRef} className="ev-table-scroll" onScroll={updateOverflow}>
        <Table.Container className="ev-editorial-table">
          <Table.Root>
            <Table.Head>
              <Table.Row>
                {token.header.map((cell, cellIdx) => {
                  const cellKey = headerKeys[cellIdx] ?? `${tableKey}.h.${cellIdx}`;
                  const kind = colKinds[cellIdx];
                  return (
                    <Table.HeaderCell
                      key={cellKey}
                      scope="col"
                      align={cellAlign(cellIdx)}
                      data-col-kind={kind}
                    >
                      {renderInline(cell.tokens, cellKey)}
                    </Table.HeaderCell>
                  );
                })}
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {token.rows.map((row, rowIdx) => {
                const rowKey = `${tableKey}.tr.${rowIdx}.${row.map((c) => c.text).join("|")}`;
                return (
                  <Table.Row key={rowKey}>
                    {row.map((cell, cellIdx) => {
                      const cellKey = `${rowKey}.${headerKeys[cellIdx] ?? cellIdx}`;
                      const kind = colKinds[cellIdx];
                      return (
                        <Table.Cell
                          key={cellKey}
                          align={cellAlign(cellIdx)}
                          className={kind === "number" ? "ev-num" : undefined}
                          data-col-kind={kind}
                        >
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
      </div>
    </div>
  );
}

type RenderBlocksContext = {
  readonly streaming: boolean;
  readonly headingPrefix?: string;
  headingCounter: number;
};

function renderBlocks(
  tokens: readonly Token[],
  prefix: string,
  ctx: RenderBlocksContext,
): ReactNode {
  return tokens.map((token, index) => {
    const key = `${prefix}.${index}`;
    if (!isMarkedToken(token)) return <Text key={key}>{token.raw}</Text>;
    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        const level = Math.min(6, Math.max(3, token.depth + 2)) as 3 | 4 | 5 | 6;
        const headingIdx = ctx.headingCounter++;
        const id =
          ctx.headingPrefix && token.depth <= 3
            ? `${ctx.headingPrefix}-${slugifyHeading(token.text, headingIdx)}`
            : undefined;
        return (
          <Heading key={key} id={id} level={level} variant="app" size={level <= 4 ? 5 : 6}>
            {renderInline(token.tokens, key)}
          </Heading>
        );
      }
      case "paragraph":
        return <Text key={key}>{renderInline(token.tokens, key)}</Text>;
      case "text":
        return <Text key={key}>{token.tokens ? renderInline(token.tokens, key) : token.text}</Text>;
      case "code":
        return (
          <CodeBlock key={key} code={token.text} lang={token.lang} streaming={ctx.streaming} />
        );
      case "blockquote":
        return <Blockquote key={key}>{renderBlocks(token.tokens, key, ctx)}</Blockquote>;
      case "hr":
        return <Separator key={key} />;
      case "list": {
        const items = token.items.map((item, itemIdx) => {
          const itemKey = `${key}.li.${itemIdx}`;
          const prefixMark = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
          return (
            <List.Item key={itemKey}>
              {prefixMark}
              {renderBlocks(item.tokens, itemKey, ctx)}
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
      case "table":
        return <EditorialTable key={key} token={token} tableKey={key} />;
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
  headingPrefix,
}: {
  readonly text: string;
  readonly streaming?: boolean;
  readonly headingPrefix?: string;
}) {
  const { t } = useI18n();
  const tokens = useMemo(() => marked.lexer(text, { gfm: true, breaks: false }), [text]);
  const ctx: RenderBlocksContext = { streaming, headingPrefix, headingCounter: 0 };
  return (
    <Prose className="eevee-markdown">
      {renderBlocks(tokens, "md", ctx)}
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
