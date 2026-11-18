import type { Client } from "@shared/api/client.ts";
import type { ModelsView } from "@shared/api/contract.ts";
import { ref, shallowRef } from "vue";

// One copy of the model catalog for the settings page and the composer, so a default changed in one
// shows in the other without a second load.
const view = shallowRef<ModelsView>();
const error = ref<string>();
const loading = ref(false);

export function useModelsView(client: Client) {
  async function load(): Promise<void> {
    loading.value = true;
    error.value = undefined;
    try {
      view.value = await client.call("GET /api/models");
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  return { view, error, loading, load };
}
