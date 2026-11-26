import { VisibilityIcon } from "@earendil-works/elanor-icons-react";
import { Button, Collapsible, EmptyState, Stack, Text } from "@earendil-works/elanor-react";
import type { ConversationRef, EntryRecordPayload, WorkerId } from "@eevee/protocol";
import { useEffect, useMemo, useRef } from "react";
import {
  buildTranscriptItems,
  type InboxPreview,
  type LiveDocView,
  type NoticeMeta,
} from "../lib/transcript.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolBlock } from "./ToolBlock.tsx";

function noticeLabel(meta: NoticeMeta): {
  readonly title: string;
  readonly tone: "info" | "negative" | "neutral";
} {
  switch (meta.type) {
    case "handoff":
      return {
        title: `Worker 交棒 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "info",
      };
    case "worker_message":
      return {
        title: `Worker 消息 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "info",
      };
    case "worker_failed":
      return {
        title: `Worker 执行失败 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "negative",
      };
    case "question_answered":
      return { title: `用户答复 · ${meta.questionId ?? ""}`, tone: "neutral" };
    case "task_notification":
      return { title: `后台任务通知 · ${meta.taskId ?? ""}`, tone: "info" };
    default:
      return { title: `系统通知 · ${meta.type}`, tone: "neutral" };
  }
}

export type TranscriptViewProps = {
  readonly activeRef: ConversationRef;
  readonly entries: readonly EntryRecordPayload[];
  readonly live: LiveDocView;
  readonly inbox: readonly InboxPreview[];
  readonly hasMoreOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  readonly onSelectWorker: (workerId: WorkerId) => void;
};

export function TranscriptView({
  activeRef,
  entries,
  live,
  inbox,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  onSelectWorker,
}: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const items = useMemo(() => buildTranscriptItems(entries, live), [entries, live]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const scrollSignal = `${activeRef}:${items.length}:${live.partialText.length}:${live.activeTools.length}:${inbox.length}`;
  useEffect(() => {
    void scrollSignal;
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollSignal]);

  const hasPartial =
    live.busy &&
    (live.partialText.length > 0 ||
      live.partialThinking.length > 0 ||
      live.partialTools.length > 0);

  return (
    <div ref={scrollRef} className="eevee-transcript-scroll" onScroll={handleScroll}>
      <div className="eevee-transcript-inner">
        {hasMoreOlder && (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Button
              hierarchy="secondary"
              density="compact"
              pending={loadingOlder}
              onClick={onLoadOlder}
            >
              加载更早历史
            </Button>
          </div>
        )}

        {items.length === 0 && !hasPartial && !live.busy && (
          <EmptyState.Root>
            <EmptyState.Body>
              <EmptyState.Copy>
                <EmptyState.Title level={2}>
                  {activeRef === "router" ? "与 Router 开始协作" : `正在观察 Worker ${activeRef}`}
                </EmptyState.Title>
                <EmptyState.Description>
                  {activeRef === "router"
                    ? "描述你的目标，Router 会拆解工作并派出可复用的后台 Worker。"
                    : "此处展示该 Worker 的完整执行轨迹，你也可以随时发送引导或打断。"}
                </EmptyState.Description>
              </EmptyState.Copy>
            </EmptyState.Body>
          </EmptyState.Root>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} className="eevee-msg eevee-msg-user">
                <Markdown text={item.text} />
              </div>
            );
          }

          if (item.kind === "notice") {
            const label = noticeLabel(item.meta);
            const targetWorker = item.meta.workerId as WorkerId | undefined;
            return (
              <div key={item.id} className="eevee-notice-card" data-tone={label.tone}>
                <Stack
                  direction="row"
                  gap="small"
                  align="center"
                  style={{ justifyContent: "space-between" }}
                >
                  <Stack direction="row" gap="xSmall" align="center">
                    <span
                      className="eevee-badge"
                      data-tone={
                        label.tone === "negative"
                          ? "negative"
                          : label.tone === "info"
                            ? "info"
                            : "neutral"
                      }
                    >
                      {label.title}
                    </span>
                    {item.meta.ticketId && (
                      <span className="eevee-badge">{item.meta.ticketId}</span>
                    )}
                  </Stack>
                  {targetWorker && activeRef === "router" && (
                    <Button
                      hierarchy="tertiary"
                      density="compact"
                      iconStart={<VisibilityIcon width={15} height={15} />}
                      onClick={() => onSelectWorker(targetWorker)}
                    >
                      观察 {targetWorker}
                    </Button>
                  )}
                </Stack>
                <Markdown text={item.text} />
              </div>
            );
          }

          if (item.kind === "compaction") {
            return (
              <div key={item.id}>
                <div className="eevee-marker">上下文已压缩</div>
                {item.summary && (
                  <Collapsible.Root>
                    <Collapsible.Trigger className="eevee-tool-trigger">
                      查看压缩摘要
                    </Collapsible.Trigger>
                    <Collapsible.Panel>
                      <pre className="eevee-pre">{item.summary}</pre>
                    </Collapsible.Panel>
                  </Collapsible.Root>
                )}
              </div>
            );
          }

          if (item.kind === "reset") {
            return (
              <div key={item.id} className="eevee-marker">
                上下文已重置
              </div>
            );
          }

          return (
            <div key={item.id} className="eevee-msg eevee-msg-assistant">
              {item.thinking && (
                <Collapsible.Root>
                  <Collapsible.Trigger className="eevee-tool-trigger">
                    <span className="eevee-thinking">思考过程（点击展开）</span>
                  </Collapsible.Trigger>
                  <Collapsible.Panel>
                    <pre className="eevee-pre">{item.thinking}</pre>
                  </Collapsible.Panel>
                </Collapsible.Root>
              )}
              {item.text && <Markdown text={item.text} />}
              {item.tools.length > 0 && (
                <div className="eevee-tool-group">
                  {item.tools.map((tool) => (
                    <ToolBlock key={tool.id} tool={tool} />
                  ))}
                </div>
              )}
              {item.error && <div className="eevee-error-banner">响应异常：{item.error}</div>}
            </div>
          );
        })}

        {hasPartial && (
          <div className="eevee-msg eevee-msg-assistant">
            {live.partialThinking && (
              <Collapsible.Root defaultOpen>
                <Collapsible.Trigger className="eevee-tool-trigger">
                  <span className="eevee-thinking">思考中…</span>
                </Collapsible.Trigger>
                <Collapsible.Panel>
                  <pre className="eevee-pre">{live.partialThinking}</pre>
                </Collapsible.Panel>
              </Collapsible.Root>
            )}
            {live.partialText && <Markdown text={live.partialText} streaming />}
            {live.partialTools.length > 0 && (
              <div className="eevee-tool-group">
                {live.partialTools.map((tool) => (
                  <ToolBlock key={tool.id} tool={tool} />
                ))}
              </div>
            )}
          </div>
        )}

        {live.busy && !hasPartial && (
          <div className="eevee-msg-header">
            <span className="eevee-streaming-dot" />
            <Text style={{ margin: 0, fontSize: "0.85rem" }}>
              {live.compacting
                ? "正在压缩上下文…"
                : live.retryError
                  ? `准备重试：${live.retryError}`
                  : "正在执行中…"}
            </Text>
          </div>
        )}

        {live.runFailure && !live.busy && (
          <div className="eevee-error-banner">
            上次执行中断（{live.runFailure.reason}）
            {live.runFailure.detail ? `：${live.runFailure.detail}` : ""}
          </div>
        )}

        {inbox.length > 0 && (
          <div className="eevee-notice-card">
            <span className="eevee-badge" data-tone="warning">
              队列中（{inbox.length}）
            </span>
            {inbox.map((item) => (
              <div key={item.id} style={{ fontSize: "0.86rem" }}>
                <span className="eevee-badge" style={{ marginInlineEnd: 6 }}>
                  {item.mode}
                </span>
                {item.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
