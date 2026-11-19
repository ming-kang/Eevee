import { type InjectionKey, inject, provide } from "vue";

/**
 * The channel between a page's transcript and its composer: the page provides it, the composer
 * registers its inserter, and the transcript calls `insert` (e.g. for "Quote selection").
 */
export type ComposerBridge = {
  setInserter(fn: ((text: string) => void) | undefined): void;
  insert(text: string): void;
};

const KEY: InjectionKey<ComposerBridge> = Symbol("composer-bridge");

export function provideComposerInsert(): ComposerBridge {
  let fn: ((text: string) => void) | undefined;
  const bridge: ComposerBridge = {
    setInserter(next) {
      fn = next;
    },
    insert(text) {
      fn?.(text);
    },
  };
  provide(KEY, bridge);
  return bridge;
}

export function useComposerInsert(): ComposerBridge | undefined {
  return inject(KEY, undefined);
}
