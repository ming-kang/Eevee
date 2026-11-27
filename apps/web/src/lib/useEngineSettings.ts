import type { EngineSettings, ModelChoice, ModelInfo } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";

type SharedState = {
  readonly settings: EngineSettings | undefined;
  readonly availableModels: readonly ModelInfo[];
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: string | undefined;
  readonly fetchedAt: number;
};

const CACHE_TTL_MS = 15_000;

let state: SharedState = {
  settings: undefined,
  availableModels: [],
  loading: false,
  loaded: false,
  error: undefined,
  fetchedAt: 0,
};

let inflight: Promise<void> | undefined;
const subscribers = new Set<(next: SharedState) => void>();

function emit(next: SharedState): void {
  state = next;
  for (const sub of subscribers) sub(next);
}

export function setCachedEngineSettings(settings: EngineSettings): void {
  emit({ ...state, settings });
}

export function invalidateEngineModelsCache(): void {
  emit({ ...state, fetchedAt: 0 });
}

export async function refreshEngineSettingsAndModels(force = false): Promise<void> {
  if (!force && state.loaded && Date.now() - state.fetchedAt < CACHE_TTL_MS) {
    return;
  }
  if (inflight) return inflight;
  emit({ ...state, loading: true, error: undefined });
  const request = Promise.all([api.getSettings(), api.listModels({ available: true })])
    .then(([settings, modelsRes]) => {
      emit({
        settings,
        availableModels: modelsRes.models,
        loading: false,
        loaded: true,
        error: undefined,
        fetchedAt: Date.now(),
      });
    })
    .catch((err: unknown) => {
      emit({
        ...state,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      inflight = undefined;
    });
  inflight = request;
  return request;
}

export async function updateGlobalRouterModel(next: ModelChoice): Promise<EngineSettings> {
  const prevSettings = state.settings;
  const optimistic: EngineSettings = {
    ...(prevSettings ?? {}),
    models: {
      ...(prevSettings?.models ?? {}),
      router: next,
    },
  };
  emit({ ...state, settings: optimistic });
  try {
    const updated = await api.patchSettings({ models: { router: next } });
    emit({ ...state, settings: updated });
    return updated;
  } catch (err) {
    emit({ ...state, settings: prevSettings });
    throw err;
  }
}

export function useEngineSettingsAndModels(enabled = true) {
  const [snap, setSnap] = useState<SharedState>(() => state);

  useEffect(() => {
    subscribers.add(setSnap);
    setSnap(state);
    if (enabled) {
      void refreshEngineSettingsAndModels(false);
    }
    return () => {
      subscribers.delete(setSnap);
    };
  }, [enabled]);

  const refresh = useCallback((force = true) => refreshEngineSettingsAndModels(force), []);

  return {
    settings: snap.settings,
    availableModels: snap.availableModels,
    loading: snap.loading,
    loaded: snap.loaded,
    error: snap.error,
    refresh,
  };
}
