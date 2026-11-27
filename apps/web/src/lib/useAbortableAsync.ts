import { useCallback, useEffect, useRef } from "react";

export type AbortableAsyncGuard = () => boolean;

export type AbortableAsyncRunner = {
  readonly run: <T>(
    task: (signal: AbortSignal, isCurrent: AbortableAsyncGuard) => Promise<T>,
  ) => Promise<T | undefined>;
  readonly abort: () => void;
  readonly dispose: () => void;
  readonly activate: () => void;
};

export function createAbortableRunner(): AbortableAsyncRunner {
  let mounted = true;
  let abortController: AbortController | undefined;
  let runId = 0;

  const abort = () => {
    runId += 1;
    abortController?.abort();
    abortController = undefined;
  };

  const activate = () => {
    mounted = true;
  };

  const dispose = () => {
    mounted = false;
    abort();
  };

  const run = async <T>(
    task: (signal: AbortSignal, isCurrent: AbortableAsyncGuard) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!mounted) return undefined;
    abortController?.abort();
    const myRunId = ++runId;
    const controller = new AbortController();
    abortController = controller;
    const isCurrent: AbortableAsyncGuard = () =>
      mounted && !controller.signal.aborted && runId === myRunId;

    try {
      const result = await task(controller.signal, isCurrent);
      return isCurrent() ? result : undefined;
    } catch (err) {
      if (!isCurrent()) return undefined;
      throw err;
    } finally {
      if (abortController === controller) {
        abortController = undefined;
      }
    }
  };

  return { run, abort, dispose, activate };
}

export type UseAbortableAsyncResult = {
  readonly run: AbortableAsyncRunner["run"];
  readonly abort: () => void;
};

export function useAbortableAsync(): UseAbortableAsyncResult {
  const runnerRef = useRef<AbortableAsyncRunner | undefined>(undefined);
  if (!runnerRef.current) {
    runnerRef.current = createAbortableRunner();
  }

  useEffect(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    runner.activate();
    return () => {
      runner.dispose();
    };
  }, []);

  const run = useCallback<AbortableAsyncRunner["run"]>(
    (task) => runnerRef.current?.run(task) ?? Promise.resolve(undefined),
    [],
  );

  const abort = useCallback(() => {
    runnerRef.current?.abort();
  }, []);

  return { run, abort };
}
