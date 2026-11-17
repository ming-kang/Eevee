import { readonly, ref } from "vue";

export type ToastItem = {
  id: number;
  message: string;
  tone?: "ok" | "error";
};

const items = ref<ToastItem[]>([]);
let nextId = 1;

export function showToast(message: string, tone: ToastItem["tone"] = "ok"): void {
  const id = nextId++;
  items.value = [...items.value, { id, message, tone }];
  setTimeout(() => {
    items.value = items.value.filter((item) => item.id !== id);
  }, 2600);
}

export function useToasts() {
  return { toasts: readonly(items), showToast };
}
