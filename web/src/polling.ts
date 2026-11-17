import { onScopeDispose, type Ref, ref, shallowRef } from "vue";

export type Polled<T> = {
  data: Ref<T | undefined>;
  error: Ref<string | undefined>;
  refresh: () => Promise<void>;
};

export function usePolling<T>(load: () => Promise<T>, intervalMs = 2000): Polled<T> {
  const data = shallowRef<T>();
  const error = ref<string>();
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      data.value = await load();
      error.value = undefined;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      inFlight = false;
    }
  }

  void refresh();
  const timer = setInterval(refresh, intervalMs);
  onScopeDispose(() => clearInterval(timer));
  return { data, error, refresh };
}
