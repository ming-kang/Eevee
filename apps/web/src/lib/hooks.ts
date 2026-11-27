import type {
  BoardViewPayload,
  ConversationRef,
  ConversationViewPayload,
  EntryRecordPayload,
} from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";

const DEFAULT_INITIAL_BACKOFF_MS = 600;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

export type BackoffStreamControl = {
  readonly signal: AbortSignal;
  readonly resetBackoff: () => void;
  readonly stop: () => void;
};

export type BackoffStreamOptions = {
  readonly signal: AbortSignal;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onError?: (err: unknown) => void;
};

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isTerminalStreamEnd(
  reason: "ended" | "aborted" | "closed" | "failed" | "terminal" | "completed",
): boolean {
  return reason === "ended" || reason === "terminal" || reason === "completed";
}

export async function runBackoffStream(
  options: BackoffStreamOptions,
  connect: (control: BackoffStreamControl) => Promise<void>,
): Promise<void> {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_BACKOFF_MS;
  let delayMs = initialDelayMs;
  let stopped = false;

  const control: BackoffStreamControl = {
    signal: options.signal,
    resetBackoff: () => {
      delayMs = initialDelayMs;
    },
    stop: () => {
      stopped = true;
    },
  };

  while (!stopped && !options.signal.aborted) {
    try {
      await connect(control);
    } catch (err) {
      if (stopped || options.signal.aborted) return;
      options.onError?.(err);
    }
    if (stopped || options.signal.aborted) return;
    await sleepWithAbort(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

export function useBoardStream(projectId: string | undefined) {
  const [board, setBoard] = useState<BoardViewPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setBoard(undefined);
      setConnected(false);
      return;
    }
    const controller = new AbortController();
    setBoard(undefined);
    setError(undefined);

    void runBackoffStream(
      {
        signal: controller.signal,
        initialDelayMs: 600,
        maxDelayMs: 8_000,
        onError: (err) => {
          setConnected(false);
          setError(err instanceof Error ? err.message : String(err));
        },
      },
      async ({ signal, resetBackoff, stop }) => {
        for await (const event of api.streamBoard(projectId, { signal })) {
          if (signal.aborted) return;
          if (event.type === "board") {
            resetBackoff();
            setBoard(event.board);
            setConnected(true);
            setError(undefined);
          } else if (event.type === "end") {
            setConnected(false);
            if (event.reason === "failed" && event.message) setError(event.message);
            if (isTerminalStreamEnd(event.reason)) stop();
            return;
          }
        }
        if (!signal.aborted) setConnected(false);
      },
    );

    return () => {
      controller.abort();
    };
  }, [projectId]);

  return { board, connected, error };
}

export function useConversationStream(
  projectId: string | undefined,
  ref: ConversationRef | undefined,
) {
  const [view, setView] = useState<ConversationViewPayload | undefined>(undefined);
  const [olderEntries, setOlderEntries] = useState<EntryRecordPayload[]>([]);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!projectId || !ref) {
      setView(undefined);
      setOlderEntries([]);
      setOlderExhausted(false);
      setConnected(false);
      return;
    }

    const controller = new AbortController();
    setView(undefined);
    setOlderEntries([]);
    setOlderExhausted(false);
    setError(undefined);

    void runBackoffStream(
      {
        signal: controller.signal,
        initialDelayMs: 600,
        maxDelayMs: 8_000,
        onError: (err) => {
          setConnected(false);
          setError(err instanceof Error ? err.message : String(err));
        },
      },
      async ({ signal, resetBackoff, stop }) => {
        for await (const event of api.streamConversation(projectId, ref, {
          signal,
          min: 60,
          max: 140,
        })) {
          if (signal.aborted) return;
          if (event.type === "snapshot" || event.type === "patch") {
            resetBackoff();
            if (event.type === "snapshot") {
              setOlderEntries([]);
              setOlderExhausted(false);
            }
            setView(event.view);
            setConnected(true);
            setError(undefined);
          } else if (event.type === "failed") {
            setError(event.message);
          } else if (event.type === "end") {
            setConnected(false);
            if (event.reason === "failed" && event.message) setError(event.message);
            if (isTerminalStreamEnd(event.reason)) stop();
            return;
          }
        }
        if (!signal.aborted) setConnected(false);
      },
    );

    return () => {
      controller.abort();
    };
  }, [projectId, ref]);

  const loadOlder = useCallback(async () => {
    if (!projectId || !ref || loadingOlder) return;
    const earliestId = olderEntries[0]?.id ?? view?.entries[0]?.id;
    if (earliestId === undefined || earliestId <= 1) {
      setOlderExhausted(true);
      return;
    }
    setLoadingOlder(true);
    try {
      const page = await api.listEntries(projectId, ref, {
        order: "descending",
        maxEntryId: earliestId - 1,
        limit: 50,
      });
      const chronological = [...page.entries].reverse();
      if (chronological.length === 0) {
        setOlderExhausted(true);
        return;
      }
      setOlderEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...chronological.filter((e) => !seen.has(e.id)), ...prev];
      });
      setOlderExhausted(page.nextCursor === undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [projectId, ref, loadingOlder, olderEntries, view]);

  const combinedEntries: EntryRecordPayload[] = (() => {
    const liveEntries = view?.entries ?? [];
    if (olderEntries.length === 0) return liveEntries;
    const liveIds = new Set(liveEntries.map((e) => e.id));
    return [...olderEntries.filter((e) => !liveIds.has(e.id)), ...liveEntries];
  })();

  const hasMoreOlder = !olderExhausted && (olderEntries.length > 0 || view?.before !== undefined);

  return {
    view,
    entries: combinedEntries,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    connected,
    error,
  };
}

export type UseProjectBoardsOptions = {
  readonly excludeProjectId?: string;
  readonly activeBoard?: {
    readonly projectId: string;
    readonly board?: BoardViewPayload;
  };
};

export function useProjectBoards(
  projectIds: readonly string[],
  enabled: boolean,
  options?: UseProjectBoardsOptions,
) {
  const [boards, setBoards] = useState<Record<string, BoardViewPayload>>({});
  const excludedId = options?.excludeProjectId ?? options?.activeBoard?.projectId;
  const activeProjectId = options?.activeBoard?.projectId;
  const activeBoard = options?.activeBoard?.board;

  const allKey = projectIds.join("\0");
  const streamKey = projectIds.filter((id) => id !== excludedId).join("\0");

  useEffect(() => {
    const allIds = allKey === "" ? [] : allKey.split("\0");
    const streamIds = streamKey === "" ? [] : streamKey.split("\0");
    if (!enabled || allIds.length === 0) {
      setBoards({});
      return;
    }

    const controllers = streamIds.map((pid) => {
      const controller = new AbortController();
      void runBackoffStream(
        {
          signal: controller.signal,
          initialDelayMs: 800,
          maxDelayMs: 10_000,
        },
        async ({ signal, resetBackoff, stop }) => {
          for await (const event of api.streamBoard(pid, { signal })) {
            if (signal.aborted) return;
            if (event.type === "board") {
              resetBackoff();
              setBoards((prev) => ({ ...prev, [pid]: event.board }));
            } else if (event.type === "end") {
              if (isTerminalStreamEnd(event.reason)) stop();
              return;
            }
          }
        },
      );
      return controller;
    });

    setBoards((prev) => {
      const keep = new Set(streamIds);
      const next: Record<string, BoardViewPayload> = {};
      for (const [id, b] of Object.entries(prev)) {
        if (keep.has(id)) next[id] = b;
      }
      return next;
    });

    return () => {
      for (const c of controllers) c.abort();
    };
  }, [allKey, streamKey, enabled]);

  return useMemo(() => {
    if (!activeProjectId || !activeBoard) return boards;
    return { ...boards, [activeProjectId]: activeBoard };
  }, [boards, activeProjectId, activeBoard]);
}
