import { useEffect, useRef } from "react";

export const SHORTCUT_PRIORITY = {
  BACKGROUND: 10,
  PAGE: 20,
  PANEL: 30,
  OVERLAY: 50,
  MODAL: 100,
  GLOBAL: 200,
} as const;

export type ShortcutKeyEventLike = {
  readonly defaultPrevented: boolean;
};

export type ShortcutLayerConfig<E extends ShortcutKeyEventLike = KeyboardEvent> = {
  readonly id: string;
  readonly active?: boolean;
  readonly priority: number;
  readonly blocksLower?: boolean;
  readonly onKeyDown?: (event: E) => boolean | undefined;
};

export type RegisteredShortcutLayer<E extends ShortcutKeyEventLike = KeyboardEvent> =
  ShortcutLayerConfig<E> & {
    readonly order: number;
  };

export function orderShortcutLayers<E extends ShortcutKeyEventLike>(
  layers: readonly RegisteredShortcutLayer<E>[],
): RegisteredShortcutLayer<E>[] {
  return layers
    .filter((layer) => layer.active ?? true)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.order - a.order;
    });
}

export function dispatchShortcutEvent<E extends ShortcutKeyEventLike>(
  layers: readonly RegisteredShortcutLayer<E>[],
  event: E,
): boolean {
  if (event.defaultPrevented) return false;
  for (const layer of orderShortcutLayers(layers)) {
    const handled = layer.onKeyDown?.(event);
    if (handled === true || event.defaultPrevented) return true;
    if (layer.blocksLower) return false;
  }
  return false;
}

export type ShortcutStack<E extends ShortcutKeyEventLike = KeyboardEvent> = {
  register(layer: ShortcutLayerConfig<E>): () => void;
  dispatch(event: E): boolean;
  snapshot(): readonly RegisteredShortcutLayer<E>[];
};

export function createShortcutStack<E extends ShortcutKeyEventLike = KeyboardEvent>(
  attach?: (listener: (event: E) => void) => () => void,
): ShortcutStack<E> {
  let nextOrder = 1;
  const layers = new Map<number, RegisteredShortcutLayer<E>>();
  let detachListener: (() => void) | undefined;

  const onWindowKeyDown = (event: E) => {
    dispatchShortcutEvent([...layers.values()], event);
  };

  return {
    register(layer) {
      const token = nextOrder++;
      layers.set(token, { ...layer, order: token });
      if (layers.size === 1 && attach && !detachListener) {
        detachListener = attach(onWindowKeyDown);
      }
      return () => {
        layers.delete(token);
        if (layers.size === 0 && detachListener) {
          detachListener();
          detachListener = undefined;
        }
      };
    },
    dispatch(event) {
      return dispatchShortcutEvent([...layers.values()], event);
    },
    snapshot() {
      return orderShortcutLayers([...layers.values()]);
    },
  };
}

const globalShortcutStack = createShortcutStack<KeyboardEvent>((listener) => {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("keydown", listener);
  return () => {
    window.removeEventListener("keydown", listener);
  };
});

export function useShortcutLayer(config: ShortcutLayerConfig<KeyboardEvent>): void {
  const onKeyDownRef = useRef(config.onKeyDown);
  onKeyDownRef.current = config.onKeyDown;

  const active = config.active ?? true;
  const blocksLower = config.blocksLower ?? false;

  useEffect(() => {
    if (!active) return;
    return globalShortcutStack.register({
      id: config.id,
      active: true,
      priority: config.priority,
      blocksLower,
      onKeyDown: (event) => onKeyDownRef.current?.(event),
    });
  }, [config.id, active, config.priority, blocksLower]);
}
