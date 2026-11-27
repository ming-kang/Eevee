import { useEffect, useState } from "react";

export type ToastItem = {
  readonly id: number;
  readonly message: string;
  readonly tone: "default" | "danger";
};

type Listener = (items: readonly ToastItem[]) => void;

let nextId = 1;
let items: ToastItem[] = [];
const timers = new Map<number, number>();
const listeners = new Set<Listener>();

function emit(): void {
  const snapshot = [...items];
  for (const listener of listeners) listener(snapshot);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function showToast(message: string, tone: "default" | "danger" = "default"): void {
  const id = nextId++;
  const overflow = items.slice(0, Math.max(0, items.length - 3));
  for (const dropped of overflow) {
    const timer = timers.get(dropped.id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.delete(dropped.id);
    }
  }
  items = [...items.slice(-3), { id, message, tone }];
  emit();
  const timer = window.setTimeout(() => {
    timers.delete(id);
    items = items.filter((item) => item.id !== id);
    emit();
  }, 3600);
  timers.set(id, timer);
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
