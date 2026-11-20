import type { InboxState, LiveState, TranscriptView } from "@earendil-works/pi-durable";
import {
  type ComputedRef,
  computed,
  onScopeDispose,
  type Ref,
  ref,
  type ShallowRef,
  shallowRef,
  watch,
} from "vue";
import type { BoardView, EngineStatus, ProjectSummary } from "../../../src/protocol/contract.ts";
import type { ConversationTopic } from "../../../src/protocol/stream.ts";
import { createConversationWatcher, type GapItem } from "../lib/conversation.ts";
import { errorText, problemText } from "../lib/errors.ts";
import type { SessionInfo } from "../lib/session.ts";
import { createStreamClient, type StreamClient, type StreamState } from "../lib/stream.ts";

export type BoardState = {
  board?: BoardView;
  error?: string;
};

type EngineData = {
  stream: ShallowRef<StreamClient | undefined>;
  streamState: Ref<StreamState>;
  status: ShallowRef<EngineStatus | undefined>;
  statusError: Ref<string | undefined>;
  projects: ComputedRef<ProjectSummary[]>;
  boards: ShallowRef<Record<string, BoardState>>;
  refreshStatus: () => Promise<void>;
  boardOf: (pid: string) => BoardState | undefined;
};

export function useEngineData(session: ShallowRef<SessionInfo | undefined>): EngineData {
  const stream = shallowRef<StreamClient>();
  const streamState = ref<StreamState>("connecting");
  const status = shallowRef<EngineStatus>();
  const statusError = ref<string>();
  const boards = shallowRef<Record<string, BoardState>>({});

  let nextWatchSeq = 1;
  const boardStops = new Map<string, () => void>();

  async function refreshStatus(): Promise<void> {
    const current = session.value;
    if (!current) return;
    try {
      status.value = await current.client.call("GET /api/status");
      statusError.value = undefined;
    } catch (cause) {
      statusError.value = errorText(cause);
    }
  }

  function syncBoardWatches(
    client: StreamClient | undefined,
    list: readonly ProjectSummary[],
  ): void {
    const wanted = new Set(client ? list.map((p) => p.id) : []);
    for (const [pid, stop] of boardStops) {
      if (!wanted.has(pid)) {
        stop();
        boardStops.delete(pid);
      }
    }
    if (!client) {
      boards.value = {};
      return;
    }
    const nextBoards: Record<string, BoardState> = {};
    for (const pid of wanted) {
      if (boards.value[pid]) nextBoards[pid] = boards.value[pid];
      if (!boardStops.has(pid)) {
        const watchId = `b${nextWatchSeq++}`;
        const stop = client.watch(watchId, {
          topic: { kind: "board", project: pid },
          onReset: () => {
            const copy = { ...boards.value };
            delete copy[pid];
            boards.value = copy;
          },
          onEvent: (event) => {
            if (event.type === "board") {
              boards.value = { ...boards.value, [pid]: { board: event.board } };
            } else if (event.type === "error") {
              boards.value = {
                ...boards.value,
                [pid]: { ...boards.value[pid], error: problemText(event.error) },
              };
            }
          },
        });
        boardStops.set(pid, stop);
      }
    }
    boards.value = nextBoards;
  }

  const projects = computed(() => status.value?.projects ?? []);

  watch(
    session,
    (nextSession, _prev, onCleanup) => {
      for (const stop of boardStops.values()) stop();
      boardStops.clear();
      boards.value = {};

      if (!nextSession) {
        stream.value = undefined;
        status.value = undefined;
        statusError.value = undefined;
        streamState.value = "closed";
        return;
      }

      status.value = nextSession.status;
      statusError.value = undefined;
      const client = createStreamClient({
        baseUrl: location.origin,
        token: nextSession.token,
      });
      stream.value = client;
      streamState.value = client.state;

      let firstHello = true;
      const offState = client.onState((next) => {
        streamState.value = next;
      });
      const offHello = client.onHello((info) => {
        const skipInitial = firstHello && info.bootId === nextSession.status.bootId;
        firstHello = false;
        if (!skipInitial) void refreshStatus();
      });

      syncBoardWatches(client, projects.value);

      onCleanup(() => {
        offState();
        offHello();
        for (const stop of boardStops.values()) stop();
        boardStops.clear();
        client.close();
        if (stream.value === client) stream.value = undefined;
      });
    },
    { immediate: true },
  );

  watch(
    projects,
    (list) => {
      syncBoardWatches(stream.value, list);
    },
    { immediate: true },
  );

  return {
    stream,
    streamState,
    status,
    statusError,
    projects,
    boards,
    refreshStatus,
    boardOf: (pid: string) => boards.value[pid],
  };
}

let convWatchSeq = 1;

export type ConversationWatch = ReturnType<typeof useConversationWatch>;

export function useConversationWatch(
  stream: ShallowRef<StreamClient | undefined>,
  topic: () => ConversationTopic | undefined,
) {
  const view = shallowRef<TranscriptView>();
  const loadingEarlier = ref(false);
  const fillingGaps = ref(false);
  const error = ref<string>();
  const ended = ref<string>();

  let currentWatcher: ReturnType<typeof createConversationWatcher> | undefined;

  watch(
    [stream, topic],
    ([client, nextTopic], _prev, onCleanup) => {
      currentWatcher?.stop();
      currentWatcher = undefined;
      view.value = undefined;
      loadingEarlier.value = false;
      fillingGaps.value = false;
      error.value = undefined;
      ended.value = undefined;

      if (!client || !nextTopic) return;

      const watcher = createConversationWatcher({
        stream: client,
        watchId: `c${convWatchSeq++}`,
        topic: nextTopic,
        onChange: (snap) => {
          view.value = snap.view;
          loadingEarlier.value = snap.loadingEarlier;
          fillingGaps.value = snap.fillingGaps;
          error.value = snap.error;
          ended.value = snap.ended;
        },
      });
      currentWatcher = watcher;

      onCleanup(() => {
        watcher.stop();
        if (currentWatcher === watcher) currentWatcher = undefined;
      });
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    currentWatcher?.stop();
    currentWatcher = undefined;
  });

  const live = computed(() => view.value?.docs["pi.live"] as LiveState | undefined);
  const running = computed(() => live.value?.run !== undefined);
  const inbox = computed(() => view.value?.docs["pi.inbox"] as InboxState | undefined);

  return {
    view,
    live,
    running,
    inbox,
    loadingEarlier,
    fillingGaps,
    error,
    ended,
    loadEarlier: () => currentWatcher?.loadEarlier() ?? Promise.resolve(),
    fillGap: (gap: GapItem) => currentWatcher?.fillGap(gap) ?? Promise.resolve(),
  };
}
