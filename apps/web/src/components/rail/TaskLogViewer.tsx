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
          <SegmentedControl.Item value="tail">尾部</SegmentedControl.Item>
          <SegmentedControl.Item value="head">头部</SegmentedControl.Item>
        </SegmentedControl.Root>

        <Stack direction="row" gap="xxSmall" align="center" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="ev-follow-btn"
            aria-pressed={log.readMode === "tail" && log.follow}
            disabled={log.readMode !== "tail"}
            title={
              log.readMode !== "tail"
                ? "仅尾部模式支持自动跟随"
                : log.follow
                  ? "暂停自动滚动"
                  : "恢复自动滚动至底部"
            }
            onClick={() => log.setFollow((prev) => !prev)}
          >
            <KeyboardDoubleArrowDownIcon width={14} height={14} />
            <span>跟随</span>
          </button>

          <IconButton
            aria-label="刷新日志"
            title="刷新日志"
            disabled={log.loading}
            onClick={log.refresh}
          >
            <RefreshIcon width={15} height={15} />
          </IconButton>

          <Button hierarchy="secondary" density="compact" onClick={() => onOpenWorker(workerId)}>
            打开 {workerId}
          </Button>

          {(task.status === "queued" || task.status === "running" || task.status === "stopping") &&
            (task.status === "stopping" || log.killing ? (
              <Button hierarchy="secondary" semantic="negative" density="compact" disabled>
                终止中…
              </Button>
            ) : log.confirmKill ? (
              <Button
                hierarchy="primary"
                semantic="negative"
                density="compact"
                onClick={() => void log.killSelected()}
              >
                确认终止
              </Button>
            ) : (
              <Button
                hierarchy="secondary"
                semantic="negative"
                density="compact"
                iconStart={<StopIcon width={14} height={14} />}
                onClick={() => log.setConfirmKill(true)}
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
          placeholder="过滤（文本或 /正则/）"
          aria-label="过滤任务输出"
        />
        {log.filter !== "" && (
          <button
            type="button"
            className="ev-task-clear-btn"
            aria-label="清空过滤"
            title="清空过滤"
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
      {task.logError && <div className="ev-error-banner">日志写入异常：{task.logError}</div>}

      <pre ref={log.preRef} className="ev-pre ev-task-pre" onScroll={log.handlePreScroll}>
        {log.output.text ||
          (log.loading
            ? "加载中…"
            : log.error
              ? ""
              : log.activeFilter !== ""
                ? "(无匹配输出)"
                : "(暂无输出)")}
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
                匹配 {log.output.matchInfo.totalMatchedLines} 行
                {log.output.matchInfo.matchedLines < log.output.matchInfo.totalMatchedLines
                  ? `（当前显示 ${log.output.matchInfo.matchedLines} 行）`
                  : ""}
                {log.output.matchInfo.scanTruncated ? " · 扫描已截断（20 MB 上限）" : ""}
              </>
            ) : log.output.truncated ? (
              <>
                {log.readMode === "head" ? "仅显示前 32KB 窗口" : "仅显示最近窗口"}
                {log.output.totalBytes !== undefined
                  ? ` · 共 ${formatBytes(log.output.totalBytes)}`
                  : ""}
              </>
            ) : log.output.totalBytes !== undefined ? (
              `共 ${formatBytes(log.output.totalBytes)}`
            ) : null}
            {task.logTruncated === true ? " · 后台日志超出上限已截断" : ""}
          </span>
          {log.streaming && isTaskActive(task.status) && (
            <span className="ev-task-stream-state">
              实时流 · {log.follow ? "跟随中" : "已暂停"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
