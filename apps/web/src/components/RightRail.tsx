import {
  ArrowBackIcon,
  CloseFullscreenIcon,
  CloseIcon,
  ExpandMoreIcon,
  KeyboardDoubleArrowDownIcon,
  OpenInFullIcon,
  RefreshIcon,
  SearchIcon,
  StopIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, SegmentedControl, Stack } from "@earendil-works/elanor-react";
import type {
  BackgroundTaskRecordPayload,
  BoardViewPayload,
  ProjectId,
  TaskReadMode,
  WhenBusy,
  WorkerBoardItemPayload,
  WorkerId,
} from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import {
  formatBytes,
  formatRelativeTime,
  isTaskActive,
  shortPath,
  taskStatusLabel,
  taskStatusPhase,
  taskStatusStage,
  workerStatusLabel,
} from "../lib/format.ts";
import { useConversationStream } from "../lib/hooks.ts";
import { showToast } from "../lib/toasts.ts";
import { parseAgentDoc, parseInbox, parseLiveDoc, type VisualStage } from "../lib/transcript.ts";
import { Composer } from "./Composer.tsx";
import { TranscriptView } from "./TranscriptView.tsx";

function workerStage(w: WorkerBoardItemPayload): VisualStage {
  if (w.status === "running") return "working";
  if (w.status === "queued") return "queued";
  if (w.status === "closed") return "done";
  return "idle";
}

function WorkerPanel({
  projectId,
  worker,
  board,
}: {
  readonly projectId: ProjectId;
  readonly worker: WorkerBoardItemPayload | undefined;
  readonly board: BoardViewPayload | undefined;
}) {
  const [subTab, setSubTab] = useState<"chat" | "details">("chat");
  const workerId = worker?.id;
  const conv = useConversationStream(projectId, workerId);
  const live = useMemo(() => parseLiveDoc(conv.view), [conv.view]);
  const inbox = useMemo(() => parseInbox(conv.view), [conv.view]);
  const agent = useMemo(() => parseAgentDoc(conv.view), [conv.view]);

  const tickets = useMemo(
    () => (board?.tickets ?? []).filter((t) => t.workerId === workerId),
    [board, workerId],
  );

  if (!worker) {
    return (
      <div className="ev-rail-scroll" style={{ fontSize: 13, color: "var(--ev-fg-subtle)" }}>
        未找到该 Worker。
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "var(--ev-hairline) solid var(--ev-separator)",
          fontSize: 12,
          color: "var(--ev-fg-subtle)",
        }}
      >
        <span className="ev-mono ev-truncate" title={worker.cwd}>
          {agent.modelLabel ??
            (worker.model ? `${worker.model.provider}/${worker.model.modelId}` : "默认模型")}
          {" · "}
          {shortPath(worker.cwd)}
        </span>
        <SegmentedControl.Root
          density="compact"
          value={[subTab]}
          onValueChange={(vals) => {
            const v = vals[0];
            if (v === "chat" || v === "details") setSubTab(v);
          }}
        >
          <SegmentedControl.Item value="chat">对话</SegmentedControl.Item>
          <SegmentedControl.Item value="details">详情</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>

      {subTab === "details" ? (
        <div className="ev-rail-scroll" style={{ gap: 10 }}>
          <div style={{ fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4 }}>
            <div>
              <strong>状态：</strong>
              {workerStatusLabel(worker.status)}
            </div>
            <div>
              <strong>工作目录：</strong>
              <span className="ev-mono">{worker.cwd}</span>
            </div>
            <div>
              <strong>创建时间：</strong>
              {formatRelativeTime(worker.createdAt)}
            </div>
          </div>

          <div className="ev-group-label" style={{ paddingLeft: 0 }}>
            <span>关联 Tickets ({tickets.length})</span>
          </div>
          {tickets.length === 0 ? (
            <span style={{ fontSize: 12.5, color: "var(--ev-fg-subtle)" }}>暂无 Ticket</span>
          ) : (
            tickets.map((t) => (
              <div
                key={t.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--ev-surface)",
                  boxShadow: "var(--ev-shadow-stroke)",
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="ev-chip-id">{t.id}</span>
                  <span style={{ fontWeight: 500, flex: 1 }}>{t.title}</span>
                  <span className="eevee-badge">{t.status}</span>
                </div>
                {t.note && (
                  <div style={{ marginTop: 4, fontSize: 12, color: "var(--ev-fg-muted)" }}>
                    {t.note}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <TranscriptView
            activeRef={worker.id}
            entries={conv.entries}
            live={live}
            hasMoreOlder={conv.hasMoreOlder}
            loadingOlder={conv.loadingOlder}
            onLoadOlder={() => void conv.loadOlder()}
            compact
          />

          <div style={{ padding: "0 12px 12px" }}>
            {worker.status === "closed" ? (
              <div
                style={{
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--ev-fg-subtle)",
                  padding: "6px 0",
                }}
              >
                该 Worker 已关闭（只读查看）
              </div>
            ) : (
              <div className="ev-composer-stack">
                {inbox.length > 0 && (
                  <div className="ev-queued-dock">
                    <span style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}>
                      队列中（{inbox.length}）
                    </span>
                    {inbox.map((item) => (
                      <div key={item.id} className="ev-truncate">
                        <span className="ev-chip-id" style={{ marginRight: 6 }}>
                          {item.mode}
                        </span>
                        {item.text}
                      </div>
                    ))}
                  </div>
                )}
                <Composer
                  draftKey={`worker:${projectId}:${worker.id}`}
                  projectId={projectId}
                  activeRef={worker.id}
                  busy={live.busy}
                  hasRunFailure={live.runFailure !== undefined}
                  compact
                  onSend={async (text: string, whenBusy: WhenBusy) => {
                    await api.sendMessage(projectId, worker.id, { text, whenBusy });
                  }}
                  onInterrupt={async () => {
                    await api.interrupt(projectId, worker.id);
                  }}
                  onRetry={async () => {
                    await api.retry(projectId, worker.id);
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const MAX_LOG_DISPLAY_CHARS = 256 * 1024;
const TASK_READ_WINDOW_BYTES = 32_768;

type LogOutputState = {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number | undefined;
  readonly matchInfo:
    | {
        readonly matchedLines: number;
        readonly totalMatchedLines: number;
        readonly scanTruncated: boolean;
      }
    | undefined;
};

const EMPTY_LOG_OUTPUT: LogOutputState = {
  text: "",
  truncated: false,
  totalBytes: undefined,
  matchInfo: undefined,
};

function clampDisplayTail(text: string): { readonly text: string; readonly clipped: boolean } {
  if (text.length <= MAX_LOG_DISPLAY_CHARS) {
    return { text, clipped: false };
  }
  let start = text.length - MAX_LOG_DISPLAY_CHARS;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff && start + 1 < text.length) {
    start += 1;
  }
  const slice = text.slice(start);
  const nl = slice.indexOf("\n");
  const clean = nl !== -1 && nl < slice.length / 2 ? slice.slice(nl + 1) : slice;
  return { text: clean, clipped: true };
}

function formatTaskError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("Invalid filter regular expression:")) {
    const detail = msg.slice("Invalid filter regular expression:".length).trim();
    return `无效的过滤正则：${detail}`;
  }
  return msg;
}

function TaskLogViewer({
  projectId,
  workerId,
  taskKey,
  task,
  onTaskUpdate,
  onOpenWorker,
}: {
  readonly projectId: ProjectId;
  readonly workerId: WorkerId;
  readonly taskKey: string;
  readonly task: BackgroundTaskRecordPayload;
  readonly onTaskUpdate: (taskKey: string, task: BackgroundTaskRecordPayload) => void;
  readonly onOpenWorker: (workerId: WorkerId) => void;
}) {
  const taskId = task.id;
  const [readMode, setReadMode] = useState<TaskReadMode>("tail");
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [output, setOutput] = useState<LogOutputState>(EMPTY_LOG_OUTPUT);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killing, setKilling] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const mountedRef = useRef(true);
  const preRef = useRef<HTMLPreElement | null>(null);
  const programmaticScrollRef = useRef(false);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (filter.trim() === "") {
      setDebouncedFilter("");
      return;
    }
    const id = window.setTimeout(() => {
      setDebouncedFilter(filter);
    }, 250);
    return () => window.clearTimeout(id);
  }, [filter]);

  const activeFilter = debouncedFilter.trim();
  const useStream = readMode === "tail" && activeFilter === "";

  useEffect(() => {
    void refreshNonce;
    const controller = new AbortController();
    const { signal } = controller;
    setError(undefined);

    if (useStream) {
      setLoading(true);
      setStreaming(true);

      const runStream = async () => {
        try {
          for await (const event of api.streamWorkerTask(projectId, workerId, taskId, {
            mode: "tail",
            bytes: TASK_READ_WINDOW_BYTES,
            signal,
          })) {
            if (signal.aborted) return;
            if (event.type === "snapshot") {
              onTaskUpdate(taskKey, event.task);
              const capped = clampDisplayTail(event.output.text);
              setOutput({
                text: capped.text,
                truncated: event.output.truncated || capped.clipped,
                totalBytes: event.output.totalBytes,
                matchInfo: undefined,
              });
              setLoading(false);
            } else if (event.type === "chunk") {
              setOutput((prev) => {
                const capped = clampDisplayTail(prev.text + event.text);
                return {
                  ...prev,
                  text: capped.text,
                  truncated: prev.truncated || capped.clipped,
                  totalBytes: event.totalBytes,
                };
              });
            } else if (event.type === "status") {
              onTaskUpdate(taskKey, event.task);
            } else if (event.type === "end") {
              if (event.reason === "failed" || event.reason === "closed") {
                setError(
                  event.message ??
                    (event.reason === "failed" ? "日志流读取失败" : "日志流连接已中断"),
                );
              }
              setStreaming(false);
              setLoading(false);
              return;
            }
          }
          if (!signal.aborted) {
            setStreaming(false);
            setLoading(false);
          }
        } catch (err) {
          if (signal.aborted) return;
          setStreaming(false);
          setLoading(false);
          setError(formatTaskError(err));
        }
      };

      void runStream();
      return () => {
        controller.abort();
      };
    }

    setStreaming(false);
    setLoading(true);

    const runRead = async () => {
      try {
        const res = await api.readWorkerTask(projectId, workerId, taskId, {
          mode: readMode,
          bytes: TASK_READ_WINDOW_BYTES,
          ...(activeFilter !== "" ? { filter: activeFilter, contextLines: 1 } : {}),
          signal,
        });
        if (signal.aborted) return;
        onTaskUpdate(taskKey, res.task);
        setOutput({
          text: res.output.text,
          truncated: res.output.truncated,
          totalBytes: res.output.totalBytes,
          matchInfo:
            res.output.matchedLines !== undefined && res.output.totalMatchedLines !== undefined
              ? {
                  matchedLines: res.output.matchedLines,
                  totalMatchedLines: res.output.totalMatchedLines,
                  scanTruncated: res.output.scanTruncated === true,
                }
              : undefined,
        });
      } catch (err) {
        if (signal.aborted) return;
        setError(formatTaskError(err));
        if (activeFilter !== "") {
          setOutput(EMPTY_LOG_OUTPUT);
        } else {
          setOutput((prev) => ({ ...prev, matchInfo: undefined }));
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };

    void runRead();
    return () => {
      controller.abort();
    };
  }, [
    projectId,
    workerId,
    taskId,
    taskKey,
    readMode,
    activeFilter,
    useStream,
    refreshNonce,
    onTaskUpdate,
  ]);

  const scrollToBottom = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  useEffect(() => {
    void output.text;
    if (readMode !== "tail" || !follow) return;
    scrollToBottom();
  }, [output.text, readMode, follow, scrollToBottom]);

  const handlePreScroll = () => {
    if (readMode !== "tail" || !follow || programmaticScrollRef.current) return;
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
    if (!atBottom) {
      setFollow(false);
    }
  };

  const killSelected = async () => {
    if (killing || (task.status !== "queued" && task.status !== "running")) return;
    setKilling(true);
    setConfirmKill(false);
    setError(undefined);
    try {
      const res = await api.killWorkerTask(projectId, workerId, task.id);
      if (!mountedRef.current) return;
      onTaskUpdate(taskKey, res.task);
      showToast(`已终止后台任务 ${task.id}`);
      if (!useStream) {
        setRefreshNonce((n) => n + 1);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(formatTaskError(err));
    } finally {
      if (mountedRef.current) setKilling(false);
    }
  };

  return (
    <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="ev-task-toolbar">
        <SegmentedControl.Root
          density="compact"
          value={[readMode]}
          onValueChange={(vals) => {
            const v = vals[0];
            if (v === "tail" || v === "head") {
              setReadMode(v);
              if (v === "tail") setFollow(true);
            }
          }}
        >
          <SegmentedControl.Item value="tail">尾部</SegmentedControl.Item>
          <SegmentedControl.Item value="head">头部</SegmentedControl.Item>
        </SegmentedControl.Root>

        <Stack direction="row" gap="xxSmall" align="center" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="ev-follow-btn"
            aria-pressed={readMode === "tail" && follow}
            disabled={readMode !== "tail"}
            title={
              readMode !== "tail"
                ? "仅尾部模式支持自动跟随"
                : follow
                  ? "暂停自动滚动"
                  : "恢复自动滚动至底部"
            }
            onClick={() => setFollow((prev) => !prev)}
          >
            <KeyboardDoubleArrowDownIcon width={14} height={14} />
            <span>跟随</span>
          </button>

          <IconButton
            aria-label="刷新日志"
            title="刷新日志"
            disabled={loading}
            onClick={() => {
              if (debouncedFilter !== filter) setDebouncedFilter(filter);
              setRefreshNonce((n) => n + 1);
            }}
          >
            <RefreshIcon width={15} height={15} />
          </IconButton>

          <Button hierarchy="secondary" density="compact" onClick={() => onOpenWorker(workerId)}>
            打开 {workerId}
          </Button>

          {(task.status === "queued" || task.status === "running" || task.status === "stopping") &&
            (task.status === "stopping" || killing ? (
              <Button hierarchy="secondary" semantic="negative" density="compact" disabled>
                终止中…
              </Button>
            ) : confirmKill ? (
              <Button
                hierarchy="primary"
                semantic="negative"
                density="compact"
                onClick={() => void killSelected()}
              >
                确认终止
              </Button>
            ) : (
              <Button
                hierarchy="secondary"
                semantic="negative"
                density="compact"
                iconStart={<StopIcon width={14} height={14} />}
                onClick={() => setConfirmKill(true)}
              >
                终止
              </Button>
            ))}
        </Stack>
      </div>

      <div className="ev-task-filter">
        <SearchIcon width={13} height={13} />
        <input
          ref={filterInputRef}
          className="ev-raw-input"
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (debouncedFilter !== filter) setDebouncedFilter(filter);
              else setRefreshNonce((n) => n + 1);
            } else if (event.key === "Escape" && filter !== "") {
              event.preventDefault();
              event.stopPropagation();
              setFilter("");
              setDebouncedFilter("");
            }
          }}
          placeholder="过滤（文本或 /正则/）"
          aria-label="过滤任务输出"
        />
        {filter !== "" && (
          <button
            type="button"
            className="ev-task-clear-btn"
            aria-label="清空过滤"
            title="清空过滤"
            onClick={() => {
              setFilter("");
              setDebouncedFilter("");
              filterInputRef.current?.focus();
            }}
          >
            <CloseIcon width={12} height={12} />
          </button>
        )}
      </div>

      {error && <div className="ev-error-banner">{error}</div>}
      {task.error && !error && <div className="ev-error-banner">{task.error}</div>}
      {task.logError && <div className="ev-error-banner">日志写入异常：{task.logError}</div>}

      <pre ref={preRef} className="ev-pre" style={{ maxHeight: 240 }} onScroll={handlePreScroll}>
        {output.text ||
          (loading ? "加载中…" : error ? "" : activeFilter !== "" ? "(无匹配输出)" : "(暂无输出)")}
      </pre>

      {(output.truncated ||
        output.totalBytes !== undefined ||
        output.matchInfo !== undefined ||
        task.logTruncated === true ||
        (streaming && isTaskActive(task.status))) && (
        <div className="ev-task-meta">
          <span>
            {output.matchInfo ? (
              <>
                匹配 {output.matchInfo.totalMatchedLines} 行
                {output.matchInfo.matchedLines < output.matchInfo.totalMatchedLines
                  ? `（当前显示 ${output.matchInfo.matchedLines} 行）`
                  : ""}
                {output.matchInfo.scanTruncated ? " · 扫描已截断（20 MB 上限）" : ""}
              </>
            ) : output.truncated ? (
              <>
                {readMode === "head" ? "仅显示前 32KB 窗口" : "仅显示最近窗口"}
                {output.totalBytes !== undefined ? ` · 共 ${formatBytes(output.totalBytes)}` : ""}
              </>
            ) : output.totalBytes !== undefined ? (
              `共 ${formatBytes(output.totalBytes)}`
            ) : null}
            {task.logTruncated === true ? " · 后台日志超出上限已截断" : ""}
          </span>
          {streaming && isTaskActive(task.status) && (
            <span style={{ color: "var(--ev-accent)" }}>
              实时流 · {follow ? "跟随中" : "已暂停"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TasksList({
  projectId,
  workers,
  onOpenWorker,
}: {
  readonly projectId: ProjectId;
  readonly workers: readonly WorkerBoardItemPayload[];
  readonly onOpenWorker: (workerId: WorkerId) => void;
}) {
  const allTasks = useMemo(() => {
    const out: { worker: WorkerBoardItemPayload; task: BackgroundTaskRecordPayload }[] = [];
    for (const w of workers) {
      for (const task of w.tasks) out.push({ worker: w, task });
    }
    return out.sort((a, b) => {
      const aActive = isTaskActive(a.task.status);
      const bActive = isTaskActive(b.task.status);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return b.task.startedAt - a.task.startedAt;
    });
  }, [workers]);

  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [liveTaskEntry, setLiveTaskEntry] = useState<
    { readonly key: string; readonly task: BackgroundTaskRecordPayload } | undefined
  >(undefined);

  const handleTaskUpdate = useCallback((taskKey: string, nextTask: BackgroundTaskRecordPayload) => {
    setLiveTaskEntry({ key: taskKey, task: nextTask });
  }, []);

  if (allTasks.length === 0) {
    return (
      <div
        style={{
          padding: "28px 12px",
          textAlign: "center",
          fontSize: 13,
          color: "var(--ev-fg-subtle)",
        }}
      >
        暂无后台任务
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {allTasks.map(({ worker, task }) => {
        const key = `${worker.id}:${task.id}`;
        const expanded = openKey === key;
        const effectiveTask =
          expanded &&
          liveTaskEntry?.key === key &&
          taskStatusPhase(liveTaskEntry.task.status) >= taskStatusPhase(task.status)
            ? liveTaskEntry.task
            : task;
        const stage = taskStatusStage(effectiveTask.status);
        return (
          <div
            key={key}
            style={{
              borderRadius: 9,
              background: expanded ? "var(--ev-surface)" : "transparent",
              boxShadow: expanded ? "var(--ev-shadow-stroke)" : undefined,
            }}
          >
            <button
              type="button"
              className="ev-rail-item"
              aria-expanded={expanded}
              onClick={() => {
                setOpenKey(expanded ? undefined : key);
                setLiveTaskEntry(undefined);
              }}
            >
              <span className="ev-dot" data-stage={stage} style={{ marginTop: 5 }} />
              <div style={{ minWidth: 0 }}>
                <div className="ev-mono ev-truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>
                  {effectiveTask.command}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--ev-fg-subtle)",
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "2px 6px",
                  }}
                >
                  <span className="ev-mono">{worker.id}</span>
                  <span>·</span>
                  <span>{taskStatusLabel(effectiveTask.status, effectiveTask.exitCode)}</span>
                  <span>·</span>
                  <span className="ev-num">{formatRelativeTime(effectiveTask.startedAt)}</span>
                  {effectiveTask.logError && (
                    <span
                      className="eevee-badge"
                      data-tone="negative"
                      title={effectiveTask.logError}
                    >
                      日志错误
                    </span>
                  )}
                  {effectiveTask.logTruncated && (
                    <span
                      className="eevee-badge"
                      data-tone="warning"
                      title="输出超出后台日志大小限制，已截断"
                    >
                      已截断
                    </span>
                  )}
                </div>
              </div>
              <span className="ev-chip-id">{effectiveTask.id}</span>
            </button>

            {expanded && (
              <TaskLogViewer
                key={key}
                projectId={projectId}
                workerId={worker.id}
                taskKey={key}
                task={effectiveTask}
                onTaskUpdate={handleTaskUpdate}
                onOpenWorker={onOpenWorker}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RightRail({
  projectId,
  board,
  activeWorkerId,
  maximized,
  onOpenWorker,
  onCloseWorker,
  onToggleMaximize,
}: {
  readonly projectId: ProjectId;
  readonly board: BoardViewPayload | undefined;
  readonly activeWorkerId: WorkerId | undefined;
  readonly maximized: boolean;
  readonly onOpenWorker: (workerId: WorkerId) => void;
  readonly onCloseWorker: () => void;
  readonly onToggleMaximize: () => void;
}) {
  const [tab, setTab] = useState<"workers" | "tasks">("workers");
  const [showClosed, setShowClosed] = useState(false);

  const workers = board?.workers ?? [];
  const tickets = board?.tickets ?? [];
  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);

  const activeWorkers = workers.filter((w) => w.status !== "closed");
  const openTicketsWithoutActiveWorker = tickets.filter(
    (t) => t.status === "open" && !activeWorkers.some((w) => w.activeTicketId === t.id),
  );
  const doneTickets = tickets.filter((t) => t.status !== "open");
  const closedWorkers = workers.filter((w) => w.status === "closed");
  const runningTasksCount = workers.reduce((sum, w) => sum + w.activeTaskCount, 0);
  const currentWorker = activeWorkerId ? workers.find((w) => w.id === activeWorkerId) : undefined;

  useEffect(() => {
    if (!activeWorkerId) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const t = event.target;
      if (t instanceof HTMLElement && t.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      onCloseWorker();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [activeWorkerId, onCloseWorker]);

  return (
    <section style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="ev-rail-head">
        {activeWorkerId ? (
          <>
            <IconButton aria-label="返回列表" title="返回列表（Esc）" onClick={onCloseWorker}>
              <ArrowBackIcon width={16} height={16} />
            </IconButton>
            <span className="ev-chip-id">{activeWorkerId}</span>
            <span className="ev-truncate" style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>
              {currentWorker?.name ?? "Worker"}
            </span>
            {currentWorker && <span className="ev-dot" data-stage={workerStage(currentWorker)} />}
            <IconButton
              aria-label={maximized ? "还原右侧面板" : "最大化 Worker 面板"}
              title={maximized ? "还原右侧面板" : "最大化 Worker 面板"}
              onClick={onToggleMaximize}
            >
              {maximized ? (
                <CloseFullscreenIcon width={15} height={15} />
              ) : (
                <OpenInFullIcon width={15} height={15} />
              )}
            </IconButton>
          </>
        ) : (
          <div className="ev-header-nav">
            <button
              type="button"
              className="ev-tab-link"
              data-active={tab === "workers"}
              onClick={() => setTab("workers")}
            >
              <span>Workers</span>
              {activeWorkers.length > 0 && (
                <span className="ev-count-badge">{activeWorkers.length}</span>
              )}
            </button>
            <button
              type="button"
              className="ev-tab-link"
              data-active={tab === "tasks"}
              onClick={() => setTab("tasks")}
            >
              <span>后台任务</span>
              {runningTasksCount > 0 && (
                <span className="ev-count-badge" data-tone="warning">
                  {runningTasksCount}
                </span>
              )}
            </button>
          </div>
        )}
      </div>

      {activeWorkerId ? (
        <WorkerPanel projectId={projectId} worker={currentWorker} board={board} />
      ) : tab === "tasks" ? (
        <div className="ev-rail-scroll">
          <TasksList projectId={projectId} workers={workers} onOpenWorker={onOpenWorker} />
        </div>
      ) : (
        <div className="ev-rail-scroll">
          {workers.length === 0 ? (
            <div
              style={{
                padding: "28px 12px",
                textAlign: "center",
                fontSize: 13,
                color: "var(--ev-fg-subtle)",
              }}
            >
              暂无 Worker
            </div>
          ) : (
            <>
              {activeWorkers.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>活跃 Workers</span>
                    <span className="ev-num">{activeWorkers.length}</span>
                  </div>
                  {activeWorkers.map((w) => {
                    const ticket = w.activeTicketId ? ticketById.get(w.activeTicketId) : undefined;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        className="ev-rail-item"
                        onClick={() => onOpenWorker(w.id)}
                      >
                        <span
                          className="ev-dot"
                          data-stage={workerStage(w)}
                          style={{ marginTop: 5 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div className="ev-truncate" style={{ fontSize: 13.5, fontWeight: 500 }}>
                            {ticket ? ticket.title : w.name}
                          </div>
                          <div
                            className="ev-truncate"
                            style={{ fontSize: 12, color: "var(--ev-fg-subtle)" }}
                          >
                            {w.name} · {workerStatusLabel(w.status)}
                            {w.activeTaskCount > 0 ? ` · ${w.activeTaskCount} 后台任务` : ""}
                          </div>
                        </div>
                        <span className="ev-chip-id">{ticket?.id ?? w.id}</span>
                      </button>
                    );
                  })}
                </>
              )}

              {openTicketsWithoutActiveWorker.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>其他进行中 Tickets</span>
                    <span className="ev-num">{openTicketsWithoutActiveWorker.length}</span>
                  </div>
                  {openTicketsWithoutActiveWorker.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="ev-rail-item"
                      onClick={() => onOpenWorker(t.workerId)}
                    >
                      <span className="ev-dot" data-stage="queued" style={{ marginTop: 5 }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="ev-truncate" style={{ fontSize: 13 }}>
                          {t.title}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}>
                          归属 {t.workerId}
                        </div>
                      </div>
                      <span className="ev-chip-id">{t.id}</span>
                    </button>
                  ))}
                </>
              )}

              {doneTickets.length > 0 && (
                <>
                  <div className="ev-group-label">
                    <span>已结束 Tickets</span>
                    <span className="ev-num">{doneTickets.length}</span>
                  </div>
                  {doneTickets.slice(0, 12).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="ev-rail-item"
                      style={{ color: "var(--ev-fg-muted)" }}
                      onClick={() => onOpenWorker(t.workerId)}
                    >
                      <span
                        className="ev-dot"
                        data-stage={t.status === "done" ? "done" : "idle"}
                        style={{ marginTop: 5 }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className="ev-truncate" style={{ fontSize: 13 }}>
                          {t.title}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}>
                          {t.workerId} · {t.status}
                        </div>
                      </div>
                      <span className="ev-chip-id">{t.id}</span>
                    </button>
                  ))}
                </>
              )}

              {closedWorkers.length > 0 && (
                <>
                  <button
                    type="button"
                    className="ev-group-label"
                    style={{
                      border: 0,
                      background: "transparent",
                      cursor: "pointer",
                      width: "100%",
                    }}
                    onClick={() => setShowClosed((prev) => !prev)}
                  >
                    <span>已关闭 Workers ({closedWorkers.length})</span>
                    <ExpandMoreIcon
                      width={15}
                      height={15}
                      style={{
                        transform: showClosed ? undefined : "rotate(-90deg)",
                        transition: "transform 120ms",
                      }}
                    />
                  </button>
                  {showClosed &&
                    closedWorkers.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className="ev-rail-item"
                        style={{ color: "var(--ev-fg-muted)" }}
                        onClick={() => onOpenWorker(w.id)}
                      >
                        <span className="ev-dot" data-stage="done" style={{ marginTop: 5 }} />
                        <div className="ev-truncate" style={{ fontSize: 13 }}>
                          {w.name}
                        </div>
                        <span className="ev-chip-id">{w.id}</span>
                      </button>
                    ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
