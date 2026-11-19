import { type InjectionKey, inject, provide } from "vue";

export type InsertAt = "caret" | "start";

/**
 * The channel between a page's transcript and its composer: the page provides it, the composer
 * registers its inserter, and the transcript calls `insert` (e.g. for "Quote selection").
 * `at: "start"` prepends before the current draft, for pulling a queued message back.
 */
export type ComposerBridge = {
  setInserter(fn: ((text: string, at?: InsertAt) => void) | undefined): void;
  insert(text: string, at?: InsertAt): void;
};

const KEY: InjectionKey<ComposerBridge> = Symbol("composer-bridge");

export function provideComposerInsert(): ComposerBridge {
  let fn: ((text: string, at?: InsertAt) => void) | undefined;
  const bridge: ComposerBridge = {
    setInserter(next) {
      fn = next;
    },
    insert(text, at) {
      fn?.(text, at);
    },
  };
  provide(KEY, bridge);
  return bridge;
}

export function useComposerInsert(): ComposerBridge | undefined {
  return inject(KEY, undefined);
}
