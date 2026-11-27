import { Button, Collapsible } from "@earendil-works/elanor-react";
import type { WorkerId } from "@eevee/protocol";
import type { ReactNode } from "react";
import { shortPath } from "../lib/format.ts";
import type { DisplayItem } from "../lib/transcript.ts";
import { Markdown } from "./Markdown.tsx";
import { DisclosureLine } from "./transcript/DisclosureLine.tsx";
import { noticeMetaLabel } from "./transcript/noticeMeta.ts";
import { WorkedGroupView } from "./transcript/WorkedGroupView.tsx";

type ItemRenderContext = {
  readonly onOpenWorker?: (workerId: WorkerId) => void;
  readonly highlightKey?: string;
  readonly wrapClass?: string;
};

type ItemRendererMap = {
  readonly [K in DisplayItem["kind"]]: (
    item: Extract<DisplayItem, { kind: K }>,
    ctx: ItemRenderContext,
  ) => ReactNode;
};

const ITEM_RENDERERS: ItemRendererMap = {
  user: (item, { wrapClass }) => (
    <div className={`ev-msg-user${wrapClass ? ` ${wrapClass}` : ""}`} data-item-key={item.key}>
      <Markdown text={item.text} />
    </div>
  ),

  notice: (item, { onOpenWorker, wrapClass }) => {
    const label = noticeMetaLabel(item.meta);
    const workerId = item.meta.workerId;
    return (
      <div
        className={`ev-notice-card${wrapClass ? ` ${wrapClass}` : ""}`}
        data-tone={label.tone}
        data-item-key={item.key}
      >
        <div className="ev-notice-head">
          <div className="ev-notice-meta-row">
            <span className="ev-dot" data-stage={label.stage} />
            <span className="ev-notice-title">{label.title}</span>
            {label.badge && (
              <span className="eevee-badge" data-tone={label.badge.tone}>
                {label.badge.text}
              </span>
            )}
            {item.meta.ticketId && <span className="ev-chip-id">{item.meta.ticketId}</span>}
          </div>
          {workerId && onOpenWorker && (
            <Button hierarchy="tertiary" density="compact" onClick={() => onOpenWorker(workerId)}>
              观察 {workerId}
            </Button>
          )}
        </div>
        <Markdown text={item.text} />
      </div>
    );
  },

  thinking: (item, { wrapClass }) => {
    const firstLine =
      item.text.replace(/\r/g, "").split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
    return (
      <DisclosureLine
        itemKey={item.key}
        wrapClass={wrapClass}
        open={item.streaming === true}
        summary={
          <>
            <span className={item.streaming ? "ev-shiny" : undefined}>
              {item.streaming ? "思考中…" : "已思考"}
            </span>
            {!item.streaming && firstLine && (
              <span className="ev-truncate ev-proc-summary-sub">{firstLine}</span>
            )}
          </>
        }
      >
        <div className={`ev-thinking-body${item.streaming ? " streaming" : ""}`}>{item.text}</div>
      </DisclosureLine>
    );
  },

  bash: (item, { wrapClass }) => (
    <DisclosureLine
      itemKey={item.key}
      wrapClass={wrapClass}
      open={item.status === "run"}
      summary={
        <>
          <span className={`ev-truncate${item.status === "run" ? " ev-shimmer" : ""}`}>
            {item.status === "run" ? "正在执行" : "执行"}{" "}
            <span className="ev-mono ev-proc-summary-mono">{item.command}</span>
          </span>
          {item.status === "err" && <span className="ev-minus">· 失败</span>}
        </>
      }
    >
      {item.output && (
        <div className="ev-proc-body">
          <pre className="ev-pre">{item.output}</pre>
        </div>
      )}
    </DisclosureLine>
  ),

  edit: (item, { wrapClass }) => {
    const verb =
      item.status === "run"
        ? item.action === "write"
          ? "正在写入"
          : "正在编辑"
        : item.action === "write"
          ? "写入"
          : "编辑";
    return (
      <DisclosureLine
        itemKey={item.key}
        editKey={item.key}
        wrapClass={wrapClass}
        summary={
          <>
            <span className={item.status === "run" ? "ev-shimmer" : undefined}>{verb}</span>
            <span className="ev-mono ev-truncate ev-proc-summary-mono" title={item.path}>
              {shortPath(item.path)}
            </span>
            {item.status === "err" ? (
              <span className="ev-minus">· 失败</span>
            ) : (
              (item.added > 0 || item.removed > 0) && (
                <span className="ev-mono ev-num ev-diff-counts">
                  {item.added > 0 && <span className="ev-plus">+{item.added}</span>}
                  {item.removed > 0 && <span className="ev-minus">−{item.removed}</span>}
                </span>
              )
            )}
          </>
        }
      >
        <div className="ev-proc-body">
          {item.error ? (
            <div className="ev-error-banner">{item.error}</div>
          ) : item.diff.length > 0 ? (
            <div className="ev-diff-box">
              {item.diff.map((line) => (
                <div key={`${item.key}:${line.id}`} className={`ev-diff-line ${line.k}`}>
                  <span>{line.k === "add" ? "+" : line.k === "del" ? "−" : " "}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </DisclosureLine>
    );
  },

  dispatch: (item, { onOpenWorker, wrapClass }) => {
    const summaryText = item.actions
      .map((a) => `${a.verb}${a.target ? ` ${a.target}` : ""}`)
      .join(" · ");
    const hasErr = item.actions.some((a) => a.status === "err");
    return (
      <DisclosureLine
        itemKey={item.key}
        wrapClass={wrapClass}
        summary={
          <>
            <span className={`ev-truncate${item.live ? " ev-shimmer" : ""}`}>{summaryText}</span>
            {hasErr && <span className="ev-minus">· 失败</span>}
          </>
        }
      >
        <div className="ev-proc-body ev-proc-stack">
          {item.actions.map((act) => {
            const workerId = act.workerId;
            return (
              <div key={act.id} className="ev-dispatch-card">
                <div className="ev-dispatch-head">
                  <span className="ev-dispatch-verb">{act.verb}</span>
                  {act.target && <span className="ev-chip-id">{act.target}</span>}
                  {workerId && onOpenWorker && (
                    <button
                      type="button"
                      className="ev-chip-id ev-dispatch-link"
                      onClick={() => onOpenWorker(workerId)}
                    >
                      打开 {workerId}
                    </button>
                  )}
                </div>
                {act.detail && <span className="ev-dispatch-detail">{act.detail}</span>}
              </div>
            );
          })}
        </div>
      </DisclosureLine>
    );
  },

  tools: (item, { wrapClass }) => {
    const label =
      item.steps.length === 1
        ? `${item.steps[0]?.name} · ${item.steps[0]?.label}`
        : `调用了 ${item.steps.length} 个工具（${item.steps
            .map((s) => s.name)
            .slice(0, 3)
            .join(", ")}）`;
    const hasErr = item.steps.some((s) => s.status === "error");
    return (
      <DisclosureLine
        itemKey={item.key}
        wrapClass={wrapClass}
        open={item.live || hasErr}
        summary={
          <>
            <span className={`ev-truncate${item.live ? " ev-shimmer" : ""}`}>{label}</span>
            {hasErr && <span className="ev-minus">· 异常</span>}
          </>
        }
      >
        <div className="ev-proc-body ev-proc-stack">
          {item.steps.map((step) => (
            <DisclosureLine
              key={step.id}
              iconSize={14}
              open={step.status === "error"}
              summary={
                <>
                  <span className="ev-mono ev-step-name">{step.name}</span>
                  <span className="ev-truncate ev-proc-summary-mono">{step.label}</span>
                </>
              }
            >
              <div className="ev-proc-body ev-proc-step-stack">
                {Object.keys(step.arguments).length > 0 && (
                  <pre className="ev-pre">{JSON.stringify(step.arguments, null, 2)}</pre>
                )}
                {(step.outputText ?? step.streamingOutput) && (
                  <pre className="ev-pre">{step.outputText ?? step.streamingOutput}</pre>
                )}
              </div>
            </DisclosureLine>
          ))}
        </div>
      </DisclosureLine>
    );
  },

  compaction: (item) => (
    <div data-item-key={item.key}>
      <div className="ev-marker">上下文已压缩</div>
      {item.summary && (
        <Collapsible.Root>
          <Collapsible.Trigger className="ev-tab-link">查看压缩摘要</Collapsible.Trigger>
          <Collapsible.Panel>
            <pre className="ev-pre ev-compaction-pre">{item.summary}</pre>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </div>
  ),

  reset: (item) => (
    <div className="ev-marker" data-item-key={item.key}>
      上下文已重置
    </div>
  ),

  worked: (item, { onOpenWorker, highlightKey }) => (
    <WorkedGroupView
      item={item}
      highlightKey={highlightKey}
      renderChild={(child) => (
        <TranscriptItemView
          key={child.key}
          item={child}
          onOpenWorker={onOpenWorker}
          highlightKey={highlightKey}
        />
      )}
    />
  ),

  assistant: (item, { wrapClass }) => (
    <div className={`ev-msg-assistant${wrapClass ? ` ${wrapClass}` : ""}`} data-item-key={item.key}>
      {item.text && <Markdown text={item.text} streaming={item.streaming === true} />}
      {item.error && <div className="ev-error-banner">响应异常：{item.error}</div>}
    </div>
  ),
};

function renderDisplayItem(item: DisplayItem, ctx: ItemRenderContext): ReactNode {
  const render = ITEM_RENDERERS[item.kind] as (
    entry: DisplayItem,
    context: ItemRenderContext,
  ) => ReactNode;
  return render(item, ctx);
}

export function TranscriptItemView({
  item,
  onOpenWorker,
  highlightKey,
}: {
  readonly item: DisplayItem;
  readonly onOpenWorker?: (workerId: WorkerId) => void;
  readonly highlightKey?: string;
}) {
  return renderDisplayItem(item, {
    onOpenWorker,
    highlightKey,
    wrapClass: highlightKey === item.key ? "ev-find-current" : undefined,
  });
}
