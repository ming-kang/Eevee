import type {
  BackgroundTaskRecordPayload,
  ProjectId,
  TaskReadMode,
  WorkerId,
} from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";

const MAX_LOG_DISPLAY_CHARS = 256 * 1024;
const TASK_READ_WINDOW_BYTES = 32_768;

export type LogMatchInfo = {
  readonly matchedLines: number;
  readonly totalMatchedLines: number;
  readonly scanTruncated: boolean;
};

export type LogOutputState = {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number | undefined;
  readonly matchInfo: LogMatchInfo | undefined;
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

export function useTaskOutput({
  projectId,
  workerId,
  taskKey,
  task,
  onTaskUpdate,
}: {
  readonly projectId: ProjectId;
  readonly workerId: WorkerId;
  readonly taskKey: string;
  readonly task: BackgroundTaskRecordPayload;
  readonly onTaskUpdate: (taskKey: string, task: BackgroundTaskRecordPayload) => void;
}) {
  const taskId = task.id;
  const [readMode, setReadModeState] = useState<TaskReadMode>("tail");
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
    if (!atBottom) setFollow(false);
  };

  const setReadMode = (nextMode: TaskReadMode) => {
    setReadModeState(nextMode);
    if (nextMode === "tail") setFollow(true);
  };

  const applyFilterImmediate = () => {
    if (debouncedFilter !== filter) setDebouncedFilter(filter);
    else setRefreshNonce((n) => n + 1);
  };

  const clearFilter = () => {
    setFilter("");
    setDebouncedFilter("");
  };

  const refresh = () => {
    if (debouncedFilter !== filter) setDebouncedFilter(filter);
    setRefreshNonce((n) => n + 1);
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

  return {
    readMode,
    setReadMode,
    filter,
    setFilter,
    activeFilter,
    applyFilterImmediate,
    clearFilter,
    follow,
    setFollow,
    output,
    loading,
    streaming,
    error,
    confirmKill,
    setConfirmKill,
    killing,
    killSelected,
    refresh,
    preRef,
    handlePreScroll,
  };
}
