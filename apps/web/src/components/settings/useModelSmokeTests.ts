import type { SmokeTestModelRequest, SmokeTestModelResponse } from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";

export type ModelSmokeState = {
  readonly loading: boolean;
  readonly request?: SmokeTestModelRequest;
  readonly result?: SmokeTestModelResponse;
  readonly error?: string;
};

export function modelSmokeKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

export type UseModelSmokeTestsResult = {
  readonly tests: Readonly<Record<string, ModelSmokeState>>;
  readonly runTest: (
    providerId: string,
    modelId: string,
    req?: SmokeTestModelRequest,
    key?: string,
  ) => Promise<void>;
  readonly cancelTest: (key: string) => void;
  readonly reset: () => void;
};

export function useModelSmokeTests(): UseModelSmokeTestsResult {
  const [tests, setTests] = useState<Record<string, ModelSmokeState>>({});
  const abortsRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const aborts = abortsRef.current;
    return () => {
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
    };
  }, []);

  const runTest = useCallback(
    async (
      providerId: string,
      modelId: string,
      req?: SmokeTestModelRequest,
      key?: string,
    ): Promise<void> => {
      const resolvedKey = key ?? modelSmokeKey(providerId, modelId);
      abortsRef.current.get(resolvedKey)?.abort();
      const controller = new AbortController();
      abortsRef.current.set(resolvedKey, controller);
      const request = req ?? {};
      setTests((prev) => ({ ...prev, [resolvedKey]: { loading: true, request } }));
      try {
        const result = await api.testProviderModel(providerId, modelId, request, controller.signal);
        if (!controller.signal.aborted && abortsRef.current.get(resolvedKey) === controller) {
          abortsRef.current.delete(resolvedKey);
          setTests((prev) => ({
            ...prev,
            [resolvedKey]: { loading: false, request, result },
          }));
        }
      } catch (err) {
        if (!controller.signal.aborted && abortsRef.current.get(resolvedKey) === controller) {
          abortsRef.current.delete(resolvedKey);
          setTests((prev) => ({
            ...prev,
            [resolvedKey]: {
              loading: false,
              request,
              error: err instanceof Error ? err.message : String(err),
            },
          }));
        }
      }
    },
    [],
  );

  const cancelTest = useCallback((key: string) => {
    abortsRef.current.get(key)?.abort();
    abortsRef.current.delete(key);
    setTests((prev) => {
      if (!Object.hasOwn(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    for (const controller of abortsRef.current.values()) controller.abort();
    abortsRef.current.clear();
    setTests({});
  }, []);

  return { tests, runTest, cancelTest, reset };
}
