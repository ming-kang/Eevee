import type {
  BoardViewPayload,
  ConversationRef,
  ConversationViewPayload,
  EntryRecordPayload,
} from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";

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
    let active = true;
    const controller = new AbortController();
    setBoard(undefined);
    setError(undefined);

    const run = async () => {
      let delayMs = 600;
      while (active && !controller.signal.aborted) {
        try {
          for await (const event of api.streamBoard(projectId, { signal: controller.signal })) {
            if (!active) return;
            delayMs = 600;
            if (event.type === "board") {
              setBoard(event.board);
              setConnected(true);
              setError(undefined);
            } else if (event.type === "end") {
              setConnected(false);
            }
          }
        } catch (err) {
          if (!active || controller.signal.aborted) return;
          setConnected(false);
          setError(err instanceof Error ? err.message : String(err));
        }
        if (!active || controller.signal.aborted) return;
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 8_000);
      }
    };

    void run();
    return () => {
      active = false;
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

    let active = true;
    const controller = new AbortController();
    setView(undefined);
    setOlderEntries([]);
    setOlderExhausted(false);
    setError(undefined);

    const run = async () => {
      let delayMs = 600;
      while (active && !controller.signal.aborted) {
        try {
          for await (const event of api.streamConversation(projectId, ref, {
            signal: controller.signal,
            min: 60,
            max: 140,
          })) {
            if (!active) return;
            delayMs = 600;
            if (event.type === "snapshot" || event.type === "patch") {
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
            }
          }
        } catch (err) {
          if (!active || controller.signal.aborted) return;
          setConnected(false);
          setError(err instanceof Error ? err.message : String(err));
        }
        if (!active || controller.signal.aborted) return;
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 8_000);
      }
    };

    void run();
    return () => {
      active = false;
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
