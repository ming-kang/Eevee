import type {
  BackgroundTaskRecordPayload,
  ProjectId,
  WorkerBoardItemPayload,
  WorkerId,
} from "@eevee/protocol";
import { useCallback, useMemo, useState } from "react";
import {
  formatRelativeTime,
  isTaskActive,
  taskStatusLabel,
  taskStatusPhase,
  taskStatusStage,
} from "../../lib/format.ts";
import { TaskLogViewer } from "./TaskLogViewer.tsx";

export function TasksList({
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
    return <div className="ev-rail-empty">暂无后台任务</div>;
  }

  return (
    <div className="ev-tasks-stack">
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
          <div key={key} className="ev-task-card" data-expanded={expanded}>
            <button
              type="button"
              className="ev-rail-item"
              aria-expanded={expanded}
              onClick={() => {
                setOpenKey(expanded ? undefined : key);
                setLiveTaskEntry(undefined);
              }}
            >
              <span className="ev-dot ev-rail-dot" data-stage={stage} />
              <div className="ev-rail-item-main">
                <div className="ev-mono ev-truncate ev-task-cmd">{effectiveTask.command}</div>
                <div className="ev-task-sub">
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
