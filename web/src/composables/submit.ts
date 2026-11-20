import { ref } from "vue";
import { errorText } from "../lib/errors.ts";

export function useSubmit() {
  const busy = ref(false);
  const error = ref<string>();

  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    try {
      await action();
      error.value = undefined;
      return true;
    } catch (cause) {
      error.value = errorText(cause);
      return false;
    } finally {
      busy.value = false;
    }
  }

  return { busy, error, run };
}
