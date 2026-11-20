import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView as DurableView,
  type EntryLoader,
  type TranscriptItem,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import type { ConversationTopic } from "../../../src/api/stream.ts";
import { errorText, problemText } from "./errors.ts";
import type { StreamClient } from "./stream.ts";

export type GapItem = Extract<TranscriptItem, { kind: "gap" }>;

export type ConversationSnapshot = {
  view: TranscriptView | undefined;
  loadingEarlier: boolean;
  fillingGaps: boolean;
  error: string | undefined;
  ended: string | undefined;
};

type ConversationWatcherOptions = {
  stream: StreamClient;
  watchId: string;
  topic: ConversationTopic;
  pageSize?: number;
  autoFillGaps?: boolean;
  onChange: (snapshot: ConversationSnapshot) => void;
};

const MAX_SERVER_ENTRIES = 200;

export function createConversationWatcher(options: ConversationWatcherOptions) {
  const pageSize = Math.min(options.pageSize ?? 50, MAX_SERVER_ENTRIES - 1);
  const autoFillGaps = options.autoFillGaps ?? true;

  let epoch = 0;
  let disposed = false;
  let rawView: DurableView | undefined;
  let view: TranscriptView | undefined;
  let loadingEarlier = false;
  let fillingCount = 0;
  let error: string | undefined;
  let ended: string | undefined;

  const loader: EntryLoader = async (query, limit) => {
    const fetchLimit = Math.min(limit + 1, MAX_SERVER_ENTRIES);
    const items = await options.stream.entries(options.topic, query, fetchLimit);
    const hasMore = items.length > limit;
    return {
      items: hasMore ? items.slice(0, limit) : items,
      ...(hasMore ? { next: { more: true } } : {}),
    };
  };

  let transcript = new ConversationTranscript(loader, { pageSize });

  function emit(): void {
    if (disposed) return;
    options.onChange({
      view,
      loadingEarlier,
      fillingGaps: fillingCount > 0,
      error,
      ended,
    });
  }

  function maybeAutoFill(items: readonly TranscriptItem[]): void {
    if (!autoFillGaps) return;
    for (const item of items) {
      if (item.kind === "gap") void fillGap(item);
    }
  }

  function applyView(nextRaw: DurableView): void {
    rawView = nextRaw;
    error = undefined;
    view = transcript.merge(rawView);
    emit();
    maybeAutoFill(view.items);
  }

  async function loadEarlier(): Promise<void> {
    if (disposed || view === undefined || loadingEarlier) return;
    const myEpoch = epoch;
    loadingEarlier = true;
    emit();
    try {
      const next = await transcript.loadEarlier(BACKGROUND_CONTEXT);
      if (disposed || epoch !== myEpoch) return;
      error = undefined;
      view = next;
    } catch (cause) {
      if (disposed || epoch !== myEpoch) return;
      error = errorText(cause);
    } finally {
      if (!disposed && epoch === myEpoch) {
        loadingEarlier = false;
        emit();
      }
    }
  }

  async function fillGap(gap: GapItem): Promise<void> {
    if (disposed || view === undefined) return;
    const myEpoch = epoch;
    fillingCount += 1;
    emit();
    try {
      const next = await transcript.fillGap(gap, BACKGROUND_CONTEXT);
      if (disposed || epoch !== myEpoch) return;
      error = undefined;
      view = next;
      maybeAutoFill(next.items);
    } catch (cause) {
      if (disposed || epoch !== myEpoch) return;
      error = errorText(cause);
    } finally {
      if (!disposed && epoch === myEpoch) {
        fillingCount = Math.max(0, fillingCount - 1);
        emit();
      }
    }
  }

  const unwatch = options.stream.watch(options.watchId, {
    topic: options.topic,
    window: () => transcript.resume,
    onReset: () => {
      epoch += 1;
      rawView = undefined;
      view = undefined;
      loadingEarlier = false;
      fillingCount = 0;
      error = undefined;
      ended = undefined;
      transcript = new ConversationTranscript(loader, { pageSize });
      emit();
    },
    onEvent: (event) => {
      switch (event.type) {
        case "value":
          applyView(event.value);
          return;
        case "ops":
          if (rawView === undefined) return;
          applyView(applyImmutable(rawView, event.ops));
          return;
        case "end":
          ended = event.reason;
          emit();
          return;
        case "error":
          error = problemText(event.error);
          emit();
          return;
      }
    },
  });

  return {
    loadEarlier,
    fillGap,
    stop(): void {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      unwatch();
    },
  };
}
