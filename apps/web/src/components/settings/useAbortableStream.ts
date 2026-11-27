import { useCallback, useEffect, useRef } from "react";

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
