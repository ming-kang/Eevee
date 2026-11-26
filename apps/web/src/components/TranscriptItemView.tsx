import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { Button, Collapsible } from "@earendil-works/elanor-react";
import type { WorkerId } from "@eevee/protocol";
import { useRef, useState } from "react";
import {
  formatDurationMs,
  shortPath,
  taskStatusLabel,
  taskStatusStage,
  taskStatusTone,
} from "../lib/format.ts";
import {
  activitySummary,
  closedWorkedItems,
  type DisplayItem,
  editSummary,
  type VisualStage,
} from "../lib/transcript.ts";
import { Markdown } from "./Markdown.tsx";

type NoticeLabelInfo = {
  readonly title: string;
  readonly tone: "default" | "danger";
  readonly stage: VisualStage;
  readonly badge?: {
    readonly text: string;
    readonly tone: "info" | "positive" | "warning" | "negative" | "neutral";
  };
};

function taskNotificationLabel(
  meta: Extract<DisplayItem, { kind: "notice" }>["meta"],
): NoticeLabelInfo {
  const idSuffix = meta.taskId ? ` · ${meta.taskId}` : "";
  const status = meta.taskStatus;
  if (status === undefined) {
    return { title: `后台任务${idSuffix}`, tone: "default", stage: "done" };
  }
  const stage = taskStatusStage(status);
  const tone = taskStatusTone(status);
  const badgeText =
    status === "cancelled" && meta.taskCancelReason === "user"
      ? "cancelled (user)"
      : taskStatusLabel(status, meta.taskExitCode);
  switch (status) {
    case "completed":
      return {
        title: `后台任务完成${idSuffix}`,
        tone: "default",
        stage,
        badge: { text: badgeText, tone },
      };
    case "failed":
      return {
        title: `后台任务失败${idSuffix}`,
        tone: "danger",
        stage,
        badge: { text: badgeText, tone },
      };
    case "timed_out":
      return {
        title: `后台任务超时${idSuffix}`,
        tone: "danger",
        stage,
        badge: { text: badgeText, tone },
      };
    case "cancelled":
      return {
        title: `后台任务已取消${idSuffix}`,
        tone: "default",
        stage,
        badge: { text: badgeText, tone },
      };
    case "interrupted":
      return {
        title: `后台任务中断${idSuffix}`,
        tone: "danger",
        stage,
        badge: { text: badgeText, tone },
      };
    case "queued":
    case "running":
    case "stopping":
      return {
        title: `后台任务${idSuffix}`,
        tone: "default",
        stage,
        badge: { text: badgeText, tone },
      };
  }
}

function noticeMetaLabel(meta: Extract<DisplayItem, { kind: "notice" }>["meta"]): NoticeLabelInfo {
  switch (meta.type) {
    case "handoff":
      return {
        title: `Worker 交棒 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "default",
        stage: "done",
      };
    case "worker_message":
      return {
        title: `Worker 消息 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "default",
        stage: "done",
      };
    case "worker_failed":
      return {
        title: `Worker 失败 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "danger",
        stage: "blocked",
      };
    case "question_answered":
      return { title: `用户答复 · ${meta.questionId ?? ""}`, tone: "default", stage: "done" };
    case "task_notification":
      return taskNotificationLabel(meta);
    default:
      return { title: `通知 · ${meta.type}`, tone: "default", stage: "done" };
  }
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
  const highlighted = highlightKey === item.key;
  const wrapClass = highlighted ? "ev-find-current" : undefined;

  if (item.kind === "user") {
    return (
      <div className={`ev-msg-user${wrapClass ? ` ${wrapClass}` : ""}`} data-item-key={item.key}>
        <Markdown text={item.text} />
      </div>
    );
  }

  if (item.kind === "notice") {
    const label = noticeMetaLabel(item.meta);
    return (
      <div
        className={`ev-notice-card${wrapClass ? ` ${wrapClass}` : ""}`}
        data-tone={label.tone}
        data-item-key={item.key}
      >
        <div className="ev-notice-head">
          <div
            style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}
          >
            <span className="ev-dot" data-stage={label.stage} />
            <span style={{ fontWeight: 500, color: "var(--ev-fg)" }}>{label.title}</span>
            {label.badge && (
              <span className="eevee-badge" data-tone={label.badge.tone}>
                {label.badge.text}
              </span>
            )}
            {item.meta.ticketId && <span className="ev-chip-id">{item.meta.ticketId}</span>}
          </div>
          {item.meta.workerId && onOpenWorker && (
            <Button
              hierarchy="tertiary"
              density="compact"
              onClick={() => onOpenWorker(item.meta.workerId as WorkerId)}
            >
              观察 {item.meta.workerId}
            </Button>
          )}
        </div>
        <Markdown text={item.text} />
      </div>
    );
  }

  if (item.kind === "thinking") {
    const firstLine =
      item.text.replace(/\r/g, "").split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
    return (
      <details
        className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
        open={item.streaming === true}
        data-item-key={item.key}
      >
        <summary>
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className={item.streaming ? "ev-shiny" : undefined}>
            {item.streaming ? "思考中…" : "已思考"}
          </span>
          {!item.streaming && firstLine && (
            <span className="ev-truncate" style={{ fontSize: 12, color: "var(--ev-fg-subtle)" }}>
              {firstLine}
            </span>
          )}
        </summary>
        <div className={`ev-thinking-body${item.streaming ? " streaming" : ""}`}>{item.text}</div>
      </details>
    );
  }

  if (item.kind === "bash") {
    return (
      <details
        className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
        open={item.status === "run"}
        data-item-key={item.key}
      >
        <summary>
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className={`ev-truncate${item.status === "run" ? " ev-shimmer" : ""}`}>
            {item.status === "run" ? "正在执行" : "执行"}{" "}
            <span className="ev-mono" style={{ fontSize: 12 }}>
              {item.command}
            </span>
          </span>
          {item.status === "err" && <span className="ev-minus">· 失败</span>}
        </summary>
        {item.output && (
          <div className="ev-proc-body">
            <pre className="ev-pre">{item.output}</pre>
          </div>
        )}
      </details>
    );
  }

  if (item.kind === "edit") {
    const verb =
      item.status === "run"
        ? item.action === "write"
          ? "正在写入"
          : "正在编辑"
        : item.action === "write"
          ? "写入"
          : "编辑";
    return (
      <details
        className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
        data-item-key={item.key}
        data-edit-key={item.key}
      >
        <summary>
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className={item.status === "run" ? "ev-shimmer" : undefined}>{verb}</span>
          <span className="ev-mono ev-truncate" style={{ fontSize: 12 }} title={item.path}>
            {shortPath(item.path)}
          </span>
          {item.status === "err" ? (
            <span className="ev-minus">· 失败</span>
          ) : (
            (item.added > 0 || item.removed > 0) && (
              <span
                className="ev-mono ev-num"
                style={{ display: "inline-flex", gap: 4, fontSize: 12 }}
              >
                {item.added > 0 && <span className="ev-plus">+{item.added}</span>}
                {item.removed > 0 && <span className="ev-minus">−{item.removed}</span>}
              </span>
            )
          )}
        </summary>
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
      </details>
    );
  }

  if (item.kind === "dispatch") {
    const summaryText = item.actions
      .map((a) => `${a.verb}${a.target ? ` ${a.target}` : ""}`)
      .join(" · ");
    const hasErr = item.actions.some((a) => a.status === "err");
    return (
      <details className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`} data-item-key={item.key}>
        <summary>
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className={`ev-truncate${item.live ? " ev-shimmer" : ""}`}>{summaryText}</span>
          {hasErr && <span className="ev-minus">· 失败</span>}
        </summary>
        <div className="ev-proc-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {item.actions.map((act) => (
            <div
              key={act.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                padding: "5px 8px",
                borderRadius: 6,
                background: "var(--ev-surface-2)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 500, color: "var(--ev-fg)" }}>{act.verb}</span>
                {act.target && <span className="ev-chip-id">{act.target}</span>}
                {act.workerId && onOpenWorker && (
                  <button
                    type="button"
                    className="ev-chip-id"
                    style={{ border: 0, cursor: "pointer", color: "var(--ev-accent)" }}
                    onClick={() => onOpenWorker(act.workerId as WorkerId)}
                  >
                    打开 {act.workerId}
                  </button>
                )}
              </div>
              {act.detail && (
                <span style={{ fontSize: 12, color: "var(--ev-fg-muted)", whiteSpace: "pre-wrap" }}>
                  {act.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      </details>
    );
  }

  if (item.kind === "tools") {
    const label =
      item.steps.length === 1
        ? `${item.steps[0]?.name} · ${item.steps[0]?.label}`
        : `调用了 ${item.steps.length} 个工具（${item.steps
            .map((s) => s.name)
            .slice(0, 3)
            .join(", ")}）`;
    const hasErr = item.steps.some((s) => s.status === "error");
    return (
      <details
        className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
        open={item.live || hasErr}
        data-item-key={item.key}
      >
        <summary>
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className={`ev-truncate${item.live ? " ev-shimmer" : ""}`}>{label}</span>
          {hasErr && <span className="ev-minus">· 异常</span>}
        </summary>
        <div className="ev-proc-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {item.steps.map((step) => (
            <details key={step.id} className="ev-proc" open={step.status === "error"}>
              <summary>
                <ChevronRightIcon width={14} height={14} className="ev-proc-chev" />
                <span className="ev-mono" style={{ color: "var(--ev-fg)" }}>
                  {step.name}
                </span>
                <span className="ev-truncate" style={{ fontSize: 12 }}>
                  {step.label}
                </span>
              </summary>
              <div
                className="ev-proc-body"
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                {Object.keys(step.arguments).length > 0 && (
                  <pre className="ev-pre">{JSON.stringify(step.arguments, null, 2)}</pre>
                )}
                {(step.outputText ?? step.streamingOutput) && (
                  <pre className="ev-pre">{step.outputText ?? step.streamingOutput}</pre>
                )}
              </div>
            </details>
          ))}
        </div>
      </details>
    );
  }

  if (item.kind === "compaction") {
    return (
      <div data-item-key={item.key}>
        <div className="ev-marker">上下文已压缩</div>
        {item.summary && (
          <Collapsible.Root>
            <Collapsible.Trigger className="ev-tab-link">查看压缩摘要</Collapsible.Trigger>
            <Collapsible.Panel>
              <pre className="ev-pre" style={{ marginTop: 6 }}>
                {item.summary}
              </pre>
            </Collapsible.Panel>
          </Collapsible.Root>
        )}
      </div>
    );
  }

  if (item.kind === "reset") {
    return (
      <div className="ev-marker" data-item-key={item.key}>
        上下文已重置
      </div>
    );
  }

  if (item.kind === "worked") {
    return <WorkedGroupView item={item} onOpenWorker={onOpenWorker} highlightKey={highlightKey} />;
  }

  return (
    <div className={`ev-msg-assistant${wrapClass ? ` ${wrapClass}` : ""}`} data-item-key={item.key}>
      {item.text && <Markdown text={item.text} streaming={item.streaming === true} />}
      {item.error && <div className="ev-error-banner">响应异常：{item.error}</div>}
    </div>
  );
}

function WorkedGroupView({
  item,
  onOpenWorker,
  highlightKey,
}: {
  readonly item: Extract<DisplayItem, { kind: "worked" }>;
  readonly onOpenWorker?: (workerId: WorkerId) => void;
  readonly highlightKey?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const label = item.ms !== undefined ? `耗时 ${formatDurationMs(item.ms)}` : "已完成执行";
  const summaryText = activitySummary(item.activity);
  const edits = editSummary(item.items);
  const shown = open ? item.items : closedWorkedItems(item);

  const revealEdit = (key: string) => {
    setOpen(true);
    window.requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(
        `[data-edit-key="${CSS.escape(key)}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("flash");
      window.setTimeout(() => target.classList.remove("flash"), 1200);
    });
  };

  return (
    <div
      ref={rootRef}
      className={`ev-worked${highlightKey === item.key ? " ev-find-current" : ""}`}
      data-item-key={item.key}
    >
      <div className="ev-worked-head">
        <button
          type="button"
          className="ev-worked-toggle"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className="ev-truncate">{label}</span>
          {summaryText && (
            <span className="ev-truncate" style={{ color: "var(--ev-fg-subtle)" }}>
              · {summaryText}
            </span>
          )}
        </button>
        {!open && edits && (
          <button
            type="button"
            className="ev-diffstat ev-num"
            aria-expanded={pathsOpen}
            title={`编辑了 ${edits.files} 个文件`}
            onClick={() => setPathsOpen((prev) => !prev)}
          >
            {edits.added > 0 && <span className="ev-plus">+{edits.added}</span>}
            {edits.removed > 0 && <span className="ev-minus">−{edits.removed}</span>}
            <ChevronRightIcon
              width={13}
              height={13}
              style={{
                transform: pathsOpen ? "rotate(90deg)" : undefined,
                transition: "transform 120ms",
                color: "var(--ev-fg-subtle)",
              }}
            />
          </button>
        )}
      </div>

      {!open && pathsOpen && edits && (
        <div style={{ marginLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
          {edits.paths.map((p) => (
            <button
              key={p.key}
              type="button"
              className="ev-tab-link"
              style={{ justifyContent: "space-between", width: "100%", height: 26 }}
              onClick={() => revealEdit(p.key)}
            >
              <span className="ev-mono ev-truncate" style={{ fontSize: 12 }} title={p.path}>
                {shortPath(p.path)}
              </span>
              <span
                className="ev-mono ev-num"
                style={{ display: "inline-flex", gap: 4, fontSize: 11.5 }}
              >
                {p.added > 0 && <span className="ev-plus">+{p.added}</span>}
                {p.removed > 0 && <span className="ev-minus">−{p.removed}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {shown.map((child) => (
        <TranscriptItemView
          key={child.key}
          item={child}
          onOpenWorker={onOpenWorker}
          highlightKey={highlightKey}
        />
      ))}
    </div>
  );
}
