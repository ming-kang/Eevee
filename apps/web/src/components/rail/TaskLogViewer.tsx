import {
  CloseIcon,
  KeyboardDoubleArrowDownIcon,
  RefreshIcon,
  SearchIcon,
  StopIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, SegmentedControl, Stack } from "@earendil-works/elanor-react";
import type { BackgroundTaskRecordPayload, ProjectId, WorkerId } from "@eevee/protocol";
import { useRef } from "react";
import { formatBytes, isTaskActive } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { useTaskOutput } from "./useTaskOutput.ts";

export function TaskLogViewer({
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
  const { t } = useI18n();
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const log = useTaskOutput({ projectId, workerId, taskKey, task, onTaskUpdate });

  return (
    <div className="ev-task-viewer">
      <div className="ev-task-toolbar">
        <SegmentedControl.Root
          density="compact"
          value={[log.readMode]}
          onValueChange={(vals) => {
            const v = vals[0];
            if (v === "tail" || v === "head") log.setReadMode(v);
          }}
        >
          <SegmentedControl.Item value="tail">{t("rail.tasks.modeTail")}</SegmentedControl.Item>
          <SegmentedControl.Item value="head">{t("rail.tasks.modeHead")}</SegmentedControl.Item>
        </SegmentedControl.Root>

        <Stack direction="row" gap="xxSmall" align="center" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="ev-follow-btn"
            aria-pressed={log.readMode === "tail" && log.follow}
            disabled={log.readMode !== "tail"}
            title={
              log.readMode !== "tail"
                ? t("rail.tasks.followOnlyTail")
                : log.follow
                  ? t("rail.tasks.pauseFollow")
                  : t("rail.tasks.resumeFollow")
            }
            onClick={() => log.setFollow((prev) => !prev)}
          >
            <KeyboardDoubleArrowDownIcon width={14} height={14} />
            <span>{t("rail.tasks.follow")}</span>
          </button>

          <IconButton
            aria-label={t("rail.tasks.refresh")}
            title={t("rail.tasks.refresh")}
            disabled={log.loading}
            onClick={log.refresh}
          >
            <RefreshIcon width={15} height={15} />
          </IconButton>

          <Button hierarchy="secondary" density="compact" onClick={() => onOpenWorker(workerId)}>
            {t("transcript.openWorker", { workerId })}
          </Button>

          {(task.status === "queued" || task.status === "running" || task.status === "stopping") &&
            (task.status === "stopping" || log.killing ? (
              <Button hierarchy="secondary" semantic="negative" density="compact" disabled>
                {t("rail.tasks.stopping")}
              </Button>
            ) : log.confirmKill ? (
              <Button
                hierarchy="primary"
                semantic="negative"
                density="compact"
                onClick={() => void log.killSelected()}
              >
                {t("rail.tasks.confirmKill")}
              </Button>
            ) : (
              <Button
                hierarchy="secondary"
                semantic="negative"
                density="compact"
                iconStart={<StopIcon width={14} height={14} />}
                onClick={() => log.setConfirmKill(true)}
              >
                {t("rail.tasks.kill")}
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
          value={log.filter}
          onChange={(event) => log.setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              log.applyFilterImmediate();
            } else if (event.key === "Escape" && log.filter !== "") {
              event.preventDefault();
              event.stopPropagation();
              log.clearFilter();
            }
          }}
          placeholder={t("rail.tasks.filterPlaceholder")}
          aria-label={t("rail.tasks.filterLabel")}
        />
        {log.filter !== "" && (
          <button
            type="button"
            className="ev-task-clear-btn"
            aria-label={t("rail.tasks.clearFilter")}
            title={t("rail.tasks.clearFilter")}
            onClick={() => {
              log.clearFilter();
              filterInputRef.current?.focus();
            }}
          >
            <CloseIcon width={12} height={12} />
          </button>
        )}
      </div>

      {log.error && <div className="ev-error-banner">{log.error}</div>}
      {task.error && !log.error && <div className="ev-error-banner">{task.error}</div>}
      {task.logError && (
        <div className="ev-error-banner">
          {t("rail.tasks.logWriteError", { error: task.logError })}
        </div>
      )}

      <pre ref={log.preRef} className="ev-pre ev-task-pre" onScroll={log.handlePreScroll}>
        {log.output.text ||
          (log.loading
            ? t("common.loading")
            : log.error
              ? ""
              : log.activeFilter !== ""
                ? t("rail.tasks.noMatchOutput")
                : t("rail.tasks.noOutput"))}
      </pre>

      {(log.output.truncated ||
        log.output.totalBytes !== undefined ||
        log.output.matchInfo !== undefined ||
        task.logTruncated === true ||
        (log.streaming && isTaskActive(task.status))) && (
        <div className="ev-task-meta">
          <span>
            {log.output.matchInfo ? (
              <>
                {t("rail.tasks.matchedLines", { total: log.output.matchInfo.totalMatchedLines })}
                {log.output.matchInfo.matchedLines < log.output.matchInfo.totalMatchedLines
                  ? t("rail.tasks.matchedShown", { shown: log.output.matchInfo.matchedLines })
                  : ""}
                {log.output.matchInfo.scanTruncated ? ` · ${t("rail.tasks.scanTruncated")}` : ""}
              </>
            ) : log.output.truncated ? (
              <>
                {log.readMode === "head" ? t("rail.tasks.headWindow") : t("rail.tasks.tailWindow")}
                {log.output.totalBytes !== undefined
                  ? ` · ${t("rail.tasks.totalBytes", { size: formatBytes(log.output.totalBytes) })}`
                  : ""}
              </>
            ) : log.output.totalBytes !== undefined ? (
              t("rail.tasks.totalBytes", { size: formatBytes(log.output.totalBytes) })
            ) : null}
            {task.logTruncated === true ? ` · ${t("rail.tasks.bgLogTruncated")}` : ""}
          </span>
          {log.streaming && isTaskActive(task.status) && (
            <span className="ev-task-stream-state">
              {t("rail.tasks.streaming")} ·{" "}
              {log.follow ? t("rail.tasks.following") : t("rail.tasks.paused")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
