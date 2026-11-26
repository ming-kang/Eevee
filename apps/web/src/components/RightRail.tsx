import {
  ArrowBackIcon,
  CloseFullscreenIcon,
  ExpandMoreIcon,
  OpenInFullIcon,
  RefreshIcon,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { formatRelativeTime, shortPath, workerStatusLabel } from "../lib/format.ts";
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

function JobsList({
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
      if (a.task.status === "running" && b.task.status !== "running") return -1;
      if (a.task.status !== "running" && b.task.status === "running") return 1;
      return b.task.startedAt - a.task.startedAt;
    });
  }, [workers]);

  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [readMode, setReadMode] = useState<TaskReadMode>("tail");
  const [logText, setLogText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmKill, setConfirmKill] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const selected = allTasks.find((entry) => `${entry.worker.id}:${entry.task.id}` === openKey);

  const fetchLog = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(undefined);
    try {
      const res = await api.readWorkerTask(projectId, selected.worker.id, selected.task.id, {
        mode: readMode,
        bytes: 32_768,
      });
      setLogText(res.output.text);
      setTruncated(res.output.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, selected, readMode]);

  useEffect(() => {
    if (!selected) return;
    void fetchLog();
    if (selected.task.status !== "running") return;
    const id = window.setInterval(() => void fetchLog(), 2200);
    return () => window.clearInterval(id);
  }, [selected, fetchLog]);

  const killSelected = async () => {
    if (!selected) return;
    try {
      await api.killWorkerTask(projectId, selected.worker.id, selected.task.id);
      setConfirmKill(undefined);
      showToast(`已终止后台任务 ${selected.task.id}`);
      await fetchLog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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
        const stage: VisualStage =
          task.status === "running"
            ? "working"
            : task.status === "exited" && task.exitCode === 0
              ? "done"
              : "blocked";
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
                setConfirmKill(undefined);
                setLogText("");
              }}
            >
              <span className="ev-dot" data-stage={stage} style={{ marginTop: 5 }} />
              <div style={{ minWidth: 0 }}>
                <div className="ev-mono ev-truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>
                  {task.command}
                </div>
                <div
                  style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)", display: "flex", gap: 6 }}
                >
                  <span className="ev-mono">{worker.id}</span>
                  <span>·</span>
                  <span>
                    {task.status}
                    {task.exitCode !== undefined ? ` (${task.exitCode})` : ""}
                  </span>
                  <span>·</span>
                  <span className="ev-num">{formatRelativeTime(task.startedAt)}</span>
                </div>
              </div>
              <span className="ev-chip-id">{task.id}</span>
            </button>

            {expanded && (
              <div
                style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                  }}
                >
                  <SegmentedControl.Root
                    density="compact"
                    value={[readMode]}
                    onValueChange={(vals) => {
                      const v = vals[0];
                      if (v === "tail" || v === "head") setReadMode(v);
                    }}
                  >
                    <SegmentedControl.Item value="tail">尾部</SegmentedControl.Item>
                    <SegmentedControl.Item value="head">头部</SegmentedControl.Item>
                  </SegmentedControl.Root>
                  <Stack direction="row" gap="xxSmall" align="center">
                    <IconButton
                      aria-label="刷新日志"
                      disabled={loading}
                      onClick={() => void fetchLog()}
                    >
                      <RefreshIcon width={15} height={15} />
                    </IconButton>
                    <Button
                      hierarchy="secondary"
                      density="compact"
                      onClick={() => onOpenWorker(worker.id)}
                    >
                      打开 {worker.id}
                    </Button>
                    {task.status === "running" &&
                      (confirmKill === key ? (
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
                          onClick={() => setConfirmKill(key)}
                        >
                          终止
                        </Button>
                      ))}
                  </Stack>
                </div>
                {error && <div className="ev-error-banner">{error}</div>}
                <pre className="ev-pre" style={{ maxHeight: 240 }}>
                  {logText || (loading ? "加载中…" : "(暂无输出)")}
                </pre>
                {truncated && (
                  <span style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}>
                    仅显示 32KB 窗口
                  </span>
                )}
              </div>
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
  const [tab, setTab] = useState<"workers" | "jobs">("workers");
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
  const runningJobsCount = workers.reduce((sum, w) => sum + w.activeTaskCount, 0);
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
              data-active={tab === "jobs"}
              onClick={() => setTab("jobs")}
            >
              <span>后台任务</span>
              {runningJobsCount > 0 && (
                <span className="ev-count-badge" data-tone="warning">
                  {runningJobsCount}
                </span>
              )}
            </button>
          </div>
        )}
      </div>

      {activeWorkerId ? (
        <WorkerPanel projectId={projectId} worker={currentWorker} board={board} />
      ) : tab === "jobs" ? (
        <div className="ev-rail-scroll">
          <JobsList projectId={projectId} workers={workers} onOpenWorker={onOpenWorker} />
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
