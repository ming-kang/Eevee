import { type RefObject, useCallback, useEffect, useRef } from "react";

export type AbortableStreamContext = {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
};

export type RunAbortableStreamOptions<TEvent> = {
  readonly open: (ctx: AbortableStreamContext) => Promise<AsyncIterable<TEvent> | undefined>;
  readonly onEvent: (event: TEvent, ctx: AbortableStreamContext) => void | Promise<void>;
  readonly onEnd?: (ctx: AbortableStreamContext) => void | Promise<void>;
  readonly onError?: (error: unknown, ctx: AbortableStreamContext) => void;
};

export type UseAbortableStreamResult = {
  readonly abort: () => void;
  readonly run: <TEvent>(options: RunAbortableStreamOptions<TEvent>) => Promise<void>;
};

export function useAbortableStream(): UseAbortableStreamResult {
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runIdRef = useRef(0);

  const abort = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = undefined;
  }, []);

  useEffect(() => abort, [abort]);

  const run = useCallback(async <TEvent>(options: RunAbortableStreamOptions<TEvent>) => {
    abortRef.current?.abort();
    const runId = ++runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    const ctx: AbortableStreamContext = {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && runIdRef.current === runId,
    };

    try {
      const iterable = await options.open(ctx);
      if (!iterable || !ctx.isCurrent()) return;
      for await (const event of iterable) {
        if (!ctx.isCurrent()) return;
        await options.onEvent(event, ctx);
      }
      if (ctx.isCurrent()) {
        await options.onEnd?.(ctx);
      }
    } catch (err) {
      if (ctx.isCurrent()) {
        options.onError?.(err, ctx);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
      }
    }
  }, []);

  return { abort, run };
}

export type AbortableSessionContext<TCallbacks> = AbortableStreamContext & {
  readonly sessionId: string;
  readonly callbacks: TCallbacks;
};

export type OpenedAbortableSession<TEvent> = {
  readonly sessionId: string;
  readonly stream: AsyncIterable<TEvent>;
};

export type RunAbortableSessionOptions<TEvent, TCallbacks> = {
  readonly open: (
    ctx: AbortableStreamContext & { readonly callbacks: TCallbacks },
  ) => Promise<OpenedAbortableSession<TEvent> | undefined>;
  readonly onEvent: (
    event: TEvent,
    ctx: AbortableSessionContext<TCallbacks>,
  ) => void | Promise<void>;
  readonly isTerminal: (event: TEvent) => boolean;
  readonly onUnexpectedEnd?: (ctx: AbortableSessionContext<TCallbacks>) => void;
  readonly onError?: (
    error: unknown,
    ctx: AbortableStreamContext & {
      readonly sessionId?: string;
      readonly callbacks: TCallbacks;
    },
  ) => void;
};

export type UseAbortableSessionStreamResult<TCallbacks> = {
  readonly abort: () => void;
  readonly callbacksRef: RefObject<TCallbacks>;
  readonly runSession: <TEvent>(
    options: RunAbortableSessionOptions<TEvent, TCallbacks>,
  ) => Promise<void>;
};

export function useAbortableSessionStream<TCallbacks>(
  callbacks: TCallbacks,
): UseAbortableSessionStreamResult<TCallbacks> {
  const { abort, run } = useAbortableStream();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const runSession = useCallback(
    async <TEvent>(options: RunAbortableSessionOptions<TEvent, TCallbacks>) => {
      let startedSessionId: string | undefined;
      let sawTerminal = false;

      await run<TEvent>({
        open: async (ctx) => {
          const opened = await options.open({ ...ctx, callbacks: callbacksRef.current });
          if (!opened || !ctx.isCurrent()) return undefined;
          startedSessionId = opened.sessionId;
          return opened.stream;
        },
        onEvent: async (event, ctx) => {
          if (options.isTerminal(event)) {
            sawTerminal = true;
          }
          if (!startedSessionId || !ctx.isCurrent()) return;
          await options.onEvent(event, {
            ...ctx,
            sessionId: startedSessionId,
            callbacks: callbacksRef.current,
          });
        },
        onEnd: (ctx) => {
          if (!sawTerminal && startedSessionId && ctx.isCurrent()) {
            options.onUnexpectedEnd?.({
              ...ctx,
              sessionId: startedSessionId,
              callbacks: callbacksRef.current,
            });
          }
        },
        onError: (err, ctx) => {
          options.onError?.(err, {
            ...ctx,
            sessionId: startedSessionId,
            callbacks: callbacksRef.current,
          });
        },
      });
    },
    [run],
  );

  return { abort, callbacksRef, runSession };
}
