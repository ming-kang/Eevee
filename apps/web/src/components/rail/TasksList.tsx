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
import { useI18n } from "../../lib/i18n.ts";
import { TaskLogViewer } from "./TaskLogViewer.tsx";

export function TasksList({
  projectId,
  workers,
  filterWorkerId,
  activeWorkerId,
  onOpenWorker,
}: {
  readonly projectId: ProjectId;
  readonly workers: readonly WorkerBoardItemPayload[];
  readonly filterWorkerId?: WorkerId;
  readonly activeWorkerId?: WorkerId;
  readonly onOpenWorker: (workerId: WorkerId) => void;
}) {
  const { t } = useI18n();
  const allTasks = useMemo(() => {
    const out: {
      readonly worker: WorkerBoardItemPayload;
      readonly task: BackgroundTaskRecordPayload;
    }[] = [];
    for (const w of workers) {
      if (filterWorkerId && w.id !== filterWorkerId) continue;
      for (const task of w.tasks) out.push({ worker: w, task });
    }
    return out.sort((a, b) => {
      const aActive = isTaskActive(a.task.status);
      const bActive = isTaskActive(b.task.status);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return b.task.startedAt - a.task.startedAt;
    });
  }, [workers, filterWorkerId]);

  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [liveTaskEntry, setLiveTaskEntry] = useState<
    { readonly key: string; readonly task: BackgroundTaskRecordPayload } | undefined
  >(undefined);

  const handleTaskUpdate = useCallback((taskKey: string, nextTask: BackgroundTaskRecordPayload) => {
    setLiveTaskEntry({ key: taskKey, task: nextTask });
  }, []);

  if (allTasks.length === 0) {
    return (
      <div className="ev-rail-empty">
        {filterWorkerId ? t("rail.tasks.emptyWorker") : t("rail.tasks.empty")}
      </div>
    );
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
        const highlighted = !filterWorkerId && worker.id === activeWorkerId;
        return (
          <div
            key={key}
            className="ev-task-card"
            data-expanded={expanded}
            data-active={highlighted}
          >
            <button
              type="button"
              className="ev-rail-ticket"
              aria-expanded={expanded}
              onClick={() => {
                setOpenKey(expanded ? undefined : key);
                setLiveTaskEntry(undefined);
              }}
            >
              <div className="ev-rail-item-main">
                <div className="ev-mono ev-truncate ev-task-cmd">{effectiveTask.command}</div>
                <div className="ev-task-sub">
                  <span className="ev-chip-id">{effectiveTask.id}</span>
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
                      {t("rail.tasks.logError")}
                    </span>
                  )}
                  {effectiveTask.logTruncated && (
                    <span
                      className="eevee-badge"
                      data-tone="warning"
                      title={
                        effectiveTask.logTruncated ? t("rail.tasks.truncatedTitle") : undefined
                      }
                    >
                      {t("rail.tasks.truncated")}
                    </span>
                  )}
                </div>
              </div>
              <span className="ev-dot" data-stage={stage} />
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
