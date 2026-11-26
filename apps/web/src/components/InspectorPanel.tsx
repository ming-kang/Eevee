import {
  CloseIcon,
  DeleteIcon,
  RefreshIcon,
  StopIcon,
  TerminalIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  Card,
  Drawer,
  Field,
  Heading,
  IconButton,
  Input,
  SegmentedControl,
  Separator,
  Stack,
  Tabs,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import type {
  BoardViewPayload,
  ConversationRef,
  ProjectSummary,
  ProjectUsageResponse,
  TaskReadMode,
  WorkerBoardItemPayload,
  WorkerId,
} from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import {
  formatCost,
  formatRelativeTime,
  formatTokens,
  shortPath,
  workerStatusLabel,
  workerStatusTone,
} from "../lib/format.ts";

export type InspectorTab = "board" | "tasks" | "project";

export type InspectorPanelProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: ProjectSummary;
  readonly board: BoardViewPayload | undefined;
  readonly activeRef: ConversationRef;
  readonly onSelectWorker: (workerId: WorkerId) => void;
  readonly onProjectUpdated: (project: ProjectSummary) => void;
  readonly onProjectDeleted: (projectId: string) => void;
};

function BoardTab({
  board,
  onSelectWorker,
}: {
  readonly board: BoardViewPayload | undefined;
  readonly onSelectWorker: (workerId: WorkerId) => void;
}) {
  const workers = board?.workers ?? [];
  const tickets = board?.tickets ?? [];
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const openTickets = tickets.filter((t) => t.status === "open").length;
  const activeWorkers = workers.filter((w) => w.status !== "closed");

  return (
    <Stack direction="column" gap="small">
      <Stack direction="row" gap="xSmall">
        <Card label="活跃 Workers" value={activeWorkers.length} style={{ flex: 1 }} />
        <Card label="进行中 Tickets" value={openTickets} style={{ flex: 1 }} />
      </Stack>

      <Heading level={4} size={6}>
        Workers ({workers.length})
      </Heading>
      {workers.length === 0 ? (
        <Text style={{ fontSize: "0.86rem", color: "var(--semantic-color-text-secondary)" }}>
          尚无 Worker。向 Router 描述任务后会自动派出。
        </Text>
      ) : (
        workers.map((worker) => {
          const ticket =
            worker.activeTicketId !== undefined ? ticketById.get(worker.activeTicketId) : undefined;
          return (
            <Card key={worker.id} style={{ padding: 10 }}>
              <Stack direction="column" gap="xxSmall">
                <Stack
                  direction="row"
                  gap="xSmall"
                  align="center"
                  style={{ justifyContent: "space-between" }}
                >
                  <button
                    type="button"
                    style={{
                      border: 0,
                      padding: 0,
                      background: "transparent",
                      color: "var(--semantic-color-text-link)",
                      cursor: "pointer",
                      font: "inherit",
                      fontWeight: 600,
                    }}
                    onClick={() => onSelectWorker(worker.id)}
                  >
                    {worker.id} · {worker.name}
                  </button>
                  <span className="eevee-badge" data-tone={workerStatusTone(worker.status)}>
                    {workerStatusLabel(worker.status)}
                  </span>
                </Stack>
                <span
                  className="eevee-mono"
                  style={{ fontSize: "0.76rem", color: "var(--semantic-color-text-secondary)" }}
                >
                  {shortPath(worker.cwd)}
                  {worker.model ? ` · ${worker.model.provider}/${worker.model.modelId}` : ""}
                </span>
                {ticket && (
                  <span style={{ fontSize: "0.82rem" }}>
                    <span className="eevee-badge" style={{ marginInlineEnd: 6 }}>
                      {ticket.id}
                    </span>
                    {ticket.title}
                  </span>
                )}
                {worker.activeTaskCount > 0 && (
                  <span
                    className="eevee-badge"
                    data-tone="info"
                    style={{ alignSelf: "flex-start" }}
                  >
                    {worker.activeTaskCount} 个后台任务运行中
                  </span>
                )}
              </Stack>
            </Card>
          );
        })
      )}

      {tickets.length > 0 && (
        <>
          <Separator />
          <Heading level={4} size={6}>
            Tickets ({tickets.length})
          </Heading>
          {tickets.map((ticket) => (
            <div
              key={ticket.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                padding: "6px 8px",
                borderRadius: "var(--semantic-dimension-radius-small)",
                border: "1px solid var(--semantic-color-border-secondary)",
                background: "var(--semantic-color-background-canvas)",
              }}
            >
              <Stack
                direction="row"
                gap="xSmall"
                align="center"
                style={{ justifyContent: "space-between" }}
              >
                <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                  {ticket.id} · {ticket.title}
                </span>
                <span
                  className="eevee-badge"
                  data-tone={
                    ticket.status === "done"
                      ? "positive"
                      : ticket.status === "open"
                        ? "info"
                        : "neutral"
                  }
                >
                  {ticket.status}
                </span>
              </Stack>
              <span style={{ fontSize: "0.76rem", color: "var(--semantic-color-text-secondary)" }}>
                归属 {ticket.workerId}
                {ticket.note ? ` · ${ticket.note}` : ""}
              </span>
            </div>
          ))}
        </>
      )}
    </Stack>
  );
}

function TasksTab({
  projectId,
  workers,
  activeRef,
}: {
  readonly projectId: string;
  readonly workers: readonly WorkerBoardItemPayload[];
  readonly activeRef: ConversationRef;
}) {
  const defaultWorker =
    activeRef !== "router"
      ? activeRef
      : (workers.find((w) => w.tasks.length > 0)?.id ?? workers[0]?.id);
  const [workerId, setWorkerId] = useState<WorkerId | undefined>(defaultWorker);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined);
  const [readMode, setReadMode] = useState<TaskReadMode>("tail");
  const [logText, setLogText] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [loadingLog, setLoadingLog] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (activeRef !== "router") setWorkerId(activeRef);
  }, [activeRef]);

  const currentWorker = workers.find((w) => w.id === workerId);
  const tasks = currentWorker?.tasks ?? [];
  const effectiveTaskId =
    selectedTaskId && tasks.some((t) => t.id === selectedTaskId) ? selectedTaskId : tasks[0]?.id;
  const activeTask = tasks.find((t) => t.id === effectiveTaskId);

  const loadLog = useCallback(async () => {
    if (!workerId || !effectiveTaskId) return;
    setLoadingLog(true);
    setError(undefined);
    try {
      const res = await api.readWorkerTask(projectId, workerId, effectiveTaskId, {
        mode: readMode,
        bytes: 32_768,
      });
      setLogText(res.output.text);
      setTruncated(res.output.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingLog(false);
    }
  }, [projectId, workerId, effectiveTaskId, readMode]);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  const killTask = async () => {
    if (!workerId || !effectiveTaskId) return;
    setKilling(true);
    setError(undefined);
    try {
      await api.killWorkerTask(projectId, workerId, effectiveTaskId);
      await loadLog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setKilling(false);
    }
  };

  if (workers.length === 0) {
    return (
      <Text style={{ fontSize: "0.86rem", color: "var(--semantic-color-text-secondary)" }}>
        尚无 Worker 后台任务。
      </Text>
    );
  }

  return (
    <Stack direction="column" gap="small">
      <select
        aria-label="选择 Worker"
        className="eevee-project-select"
        value={workerId ?? ""}
        onChange={(event) => {
          setWorkerId((event.target.value || undefined) as WorkerId | undefined);
          setSelectedTaskId(undefined);
          setLogText("");
        }}
      >
        {workers.map((w) => (
          <option key={w.id} value={w.id}>
            {w.id} · {w.name} ({w.tasks.length} tasks)
          </option>
        ))}
      </select>

      {tasks.length === 0 ? (
        <Text style={{ fontSize: "0.86rem", color: "var(--semantic-color-text-secondary)" }}>
          该 Worker 暂无后台任务记录。
        </Text>
      ) : (
        <>
          <Stack direction="column" gap="xxSmall">
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="eevee-nav-item"
                data-active={task.id === effectiveTaskId}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <TerminalIcon width={15} height={15} style={{ marginTop: 2, flexShrink: 0 }} />
                <div className="eevee-nav-body">
                  <div className="eevee-nav-title">
                    <span className="eevee-mono eevee-nav-title-text">{task.id}</span>
                    <span
                      className="eevee-badge"
                      data-tone={
                        task.status === "running"
                          ? "info"
                          : task.status === "exited" && task.exitCode === 0
                            ? "positive"
                            : "negative"
                      }
                    >
                      {task.status}
                      {task.exitCode !== undefined ? ` (${task.exitCode})` : ""}
                    </span>
                  </div>
                  <span className="eevee-nav-meta eevee-mono">{task.command}</span>
                </div>
              </button>
            ))}
          </Stack>

          {activeTask && (
            <Stack direction="column" gap="xSmall">
              <Stack
                direction="row"
                gap="xSmall"
                align="center"
                style={{ justifyContent: "space-between" }}
              >
                <SegmentedControl.Root
                  density="compact"
                  value={[readMode]}
                  onValueChange={(values) => {
                    const value = values[0];
                    if (value === "tail" || value === "head") setReadMode(value);
                  }}
                >
                  <SegmentedControl.Item value="tail">尾部</SegmentedControl.Item>
                  <SegmentedControl.Item value="head">头部</SegmentedControl.Item>
                </SegmentedControl.Root>
                <Stack direction="row" gap="xxSmall">
                  <IconButton
                    aria-label="刷新日志"
                    title="刷新日志"
                    disabled={loadingLog}
                    onClick={() => void loadLog()}
                  >
                    <RefreshIcon width={16} height={16} />
                  </IconButton>
                  {activeTask.status === "running" && (
                    <Button
                      hierarchy="secondary"
                      semantic="negative"
                      density="compact"
                      iconStart={<StopIcon width={14} height={14} />}
                      pending={killing}
                      onClick={() => void killTask()}
                    >
                      终止
                    </Button>
                  )}
                </Stack>
              </Stack>
              <span style={{ fontSize: "0.76rem", color: "var(--semantic-color-text-secondary)" }}>
                启动于 {formatRelativeTime(activeTask.startedAt)}
                {truncated ? " · 已截断（仅展示 32KB）" : ""}
              </span>
              {error && <div className="eevee-error-banner">{error}</div>}
              <pre className="eevee-pre" style={{ maxHeight: 340 }}>
                {logText || "(暂无输出)"}
              </pre>
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

function ProjectTab({
  project,
  onProjectUpdated,
  onProjectDeleted,
}: {
  readonly project: ProjectSummary;
  readonly onProjectUpdated: (project: ProjectSummary) => void;
  readonly onProjectDeleted: (projectId: string) => void;
}) {
  const [memory, setMemory] = useState(project.memory ?? "");
  const [savingMemory, setSavingMemory] = useState(false);
  const [memorySaved, setMemorySaved] = useState(false);

  const [title, setTitle] = useState(project.title);
  const [workspacesText, setWorkspacesText] = useState(project.workspaces.join("\n"));
  const [savingMeta, setSavingMeta] = useState(false);

  const [usage, setUsage] = useState<ProjectUsageResponse | undefined>(undefined);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setMemory(project.memory ?? "");
    setTitle(project.title);
    setWorkspacesText(project.workspaces.join("\n"));
    setConfirmDelete(false);
    setMemorySaved(false);
  }, [project]);

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true);
    try {
      setUsage(await api.getProjectUsage(project.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingUsage(false);
    }
  }, [project.id]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const saveMemory = async () => {
    setSavingMemory(true);
    setMemorySaved(false);
    setError(undefined);
    try {
      const res = await api.putProjectMemory(project.id, {
        memory: memory.trim().length > 0 ? memory : null,
      });
      onProjectUpdated({
        ...project,
        ...(res.memory ? { memory: res.memory } : { memory: undefined }),
      });
      setMemorySaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMemory(false);
    }
  };

  const saveMeta = async () => {
    const workspaces = workspacesText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (workspaces.length === 0) {
      setError("至少保留一个工作目录。");
      return;
    }
    setSavingMeta(true);
    setError(undefined);
    try {
      const res = await api.updateProject(project.id, {
        title: title.trim() || project.title,
        workspaces,
      });
      onProjectUpdated(res.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMeta(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteProject(project.id);
      onProjectDeleted(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const modelUsageEntries = Object.entries(usage?.usage.models ?? {});
  const totalCost = modelUsageEntries.reduce((sum, [, item]) => sum + item.cost.total, 0);
  const totalTokens = modelUsageEntries.reduce((sum, [, item]) => sum + item.totalTokens, 0);

  return (
    <Stack direction="column" gap="medium">
      {error && <div className="eevee-error-banner">{error}</div>}

      <Stack direction="column" gap="xSmall">
        <Heading level={4} size={6}>
          项目记忆
        </Heading>
        <TextArea
          rows={6}
          value={memory}
          onValueChange={(value) => {
            setMemory(value);
            setMemorySaved(false);
          }}
          placeholder="保存后会在下一次请求注入 Router 与 Worker..."
        />
        <Stack direction="row" gap="xSmall" align="center">
          <Button
            hierarchy="primary"
            density="compact"
            pending={savingMemory}
            onClick={() => void saveMemory()}
          >
            保存记忆
          </Button>
          {memorySaved && (
            <span className="eevee-badge" data-tone="positive">
              已保存
            </span>
          )}
        </Stack>
      </Stack>

      <Separator />

      <Stack direction="column" gap="xSmall">
        <Heading level={4} size={6}>
          项目设置
        </Heading>
        <Field.Root>
          <Field.Label>标题</Field.Label>
          <Input type="text" value={title} onValueChange={(value) => setTitle(value)} />
        </Field.Root>
        <Field.Root>
          <Field.Label>工作目录（每行一个，修改后实时生效）</Field.Label>
          <TextArea
            monospace
            rows={3}
            value={workspacesText}
            onValueChange={(value) => setWorkspacesText(value)}
          />
        </Field.Root>
        <Button
          hierarchy="secondary"
          density="compact"
          pending={savingMeta}
          onClick={() => void saveMeta()}
        >
          更新项目
        </Button>
      </Stack>

      <Separator />

      <Stack direction="column" gap="xSmall">
        <Stack
          direction="row"
          gap="xSmall"
          align="center"
          style={{ justifyContent: "space-between" }}
        >
          <Heading level={4} size={6}>
            用量汇总
          </Heading>
          <IconButton
            aria-label="刷新用量"
            disabled={loadingUsage}
            onClick={() => void loadUsage()}
          >
            <RefreshIcon width={15} height={15} />
          </IconButton>
        </Stack>
        <Stack direction="row" gap="xSmall">
          <Card label="总 Tokens" value={formatTokens(totalTokens)} style={{ flex: 1 }} />
          <Card label="估算费用" value={formatCost(totalCost)} style={{ flex: 1 }} />
        </Stack>
        {modelUsageEntries.map(([modelKey, stats]) => (
          <div
            key={modelKey}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              fontSize: "0.8rem",
            }}
          >
            <span className="eevee-mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {modelKey}
            </span>
            <span className="eevee-mono" style={{ whiteSpace: "nowrap" }}>
              {formatTokens(stats.totalTokens)} · {formatCost(stats.cost.total)}
            </span>
          </div>
        ))}
      </Stack>

      <Separator />

      <Stack direction="column" gap="xSmall">
        {!confirmDelete ? (
          <Button
            hierarchy="secondary"
            semantic="negative"
            density="compact"
            iconStart={<DeleteIcon width={15} height={15} />}
            onClick={() => setConfirmDelete(true)}
          >
            删除项目
          </Button>
        ) : (
          <Stack direction="column" gap="xSmall">
            <Text
              style={{
                margin: 0,
                fontSize: "0.82rem",
                color: "var(--semantic-color-text-negative)",
              }}
            >
              确定删除「{project.title}」？会停止所有 Worker 并删除会话记录（不删除本地代码文件）。
            </Text>
            <Stack direction="row" gap="xSmall">
              <Button
                hierarchy="primary"
                semantic="negative"
                density="compact"
                pending={deleting}
                onClick={() => void handleDelete()}
              >
                确认删除
              </Button>
              <Button
                hierarchy="secondary"
                density="compact"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

function InspectorBody(
  props: Omit<InspectorPanelProps, "open" | "onOpenChange"> & { readonly onClose: () => void },
) {
  const [tab, setTab] = useState<InspectorTab>("board");

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBlockEnd: "1px solid var(--semantic-color-border-secondary)",
        }}
      >
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (value === "board" || value === "tasks" || value === "project") setTab(value);
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="board">看板</Tabs.Tab>
            <Tabs.Tab value="tasks">任务</Tabs.Tab>
            <Tabs.Tab value="project">项目</Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>
        </Tabs.Root>
        <IconButton aria-label="关闭侧栏" onClick={props.onClose}>
          <CloseIcon width={16} height={16} />
        </IconButton>
      </div>

      <div className="eevee-inspector-scroll">
        {tab === "board" && <BoardTab board={props.board} onSelectWorker={props.onSelectWorker} />}
        {tab === "tasks" && (
          <TasksTab
            projectId={props.project.id}
            workers={props.board?.workers ?? []}
            activeRef={props.activeRef}
          />
        )}
        {tab === "project" && (
          <ProjectTab
            project={props.project}
            onProjectUpdated={props.onProjectUpdated}
            onProjectDeleted={props.onProjectDeleted}
          />
        )}
      </div>
    </>
  );
}

export function InspectorPanel(props: InspectorPanelProps) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 900 : false,
  );

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!props.open) return null;

  if (narrow) {
    return (
      <Drawer.Root open={props.open} onOpenChange={props.onOpenChange} swipeDirection="right">
        <Drawer.Portal>
          <Drawer.Backdrop />
          <Drawer.Viewport>
            <Drawer.Popup
              style={{ width: "min(92vw, 380px)", display: "flex", flexDirection: "column" }}
            >
              <InspectorBody {...props} onClose={() => props.onOpenChange(false)} />
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <aside className="eevee-inspector">
      <InspectorBody {...props} onClose={() => props.onOpenChange(false)} />
    </aside>
  );
}
