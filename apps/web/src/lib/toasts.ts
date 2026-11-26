import { useEffect, useState } from "react";

export type ToastItem = {
  readonly id: number;
  readonly message: string;
  readonly tone: "default" | "danger";
};

type Listener = (items: readonly ToastItem[]) => void;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  const snapshot = [...items];
  for (const listener of listeners) listener(snapshot);
}

export function showToast(message: string, tone: "default" | "danger" = "default"): void {
  const id = nextId++;
  items = [...items.slice(-3), { id, message, tone }];
  emit();
  window.setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, 3200);
}

export function useToasts(): readonly ToastItem[] {
  const [state, setState] = useState<readonly ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
