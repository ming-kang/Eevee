import { computed, reactive, ref, type WritableComputedRef } from "vue";

/**
 * Which folded lines the reader opened or closed, remembered per conversation in localStorage.
 * Entries are keyed `${foldScope}|${itemKey}` and hold 0|1; the newest 500 choices are kept.
 * Storage may be absent (tests, locked-down browsers) — everything degrades to in-memory.
 */

const STORE_KEY = "eevee.folds.v1";
const CAP = 500;

export type FoldMap = Map<string, 0 | 1>;

/** The stored map, forgiving anything that isn't an object of 0|1 entries. */
export function parseFolds(raw: string | null): FoldMap {
  const map: FoldMap = new Map();
  if (raw === null) return map;
  try {
    const data: unknown = JSON.parse(raw);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return map;
    const entries = Object.entries(data).filter(
      (entry): entry is [string, 0 | 1] => entry[1] === 0 || entry[1] === 1,
    );
    for (const [key, value] of entries.slice(-CAP)) map.set(key, value);
  } catch {
    return new Map();
  }
  return map;
}

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type FoldStore = {
  /** The reader's recorded choice, or the line's default (closed) when none was stored. */
  open(id: string, fallback?: boolean): boolean;
  set(id: string, open: boolean): void;
  /** Bumped on every recorded choice — layouts a fold can change watch it to remeasure. */
  readonly revision: number;
};

const read = (storage: Storage | undefined): string | null => {
  try {
    return storage?.getItem(STORE_KEY) ?? null;
  } catch {
    return null;
  }
};

const write = (storage: Storage | undefined, map: FoldMap): void => {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // A denied or full store only loses the memory of what was folded, not the page.
  }
};

export function createFoldStore(storage: Storage | undefined, cap = CAP): FoldStore {
  const map = reactive(parseFolds(read(storage)));
  const revision = ref(0);
  return {
    open: (id, fallback = false) => {
      const value = map.get(id);
      return value === undefined ? fallback : value === 1;
    },
    set: (id, open) => {
      map.delete(id);
      map.set(id, open ? 1 : 0);
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      revision.value += 1;
      write(storage, map);
    },
    get revision() {
      return revision.value;
    },
  };
}

const storage = ((): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
})();

/** The page's shared store: a choice in one view holds in another instance of the same scope. */
export const folds = createFoldStore(storage);

/** A component's handle on one foldable line: the stored choice, or its default while unrecorded. */
export function fold(id: () => string, fallback: boolean): WritableComputedRef<boolean> {
  return computed({
    get: () => folds.open(id(), fallback),
    set: (open) => folds.set(id(), open),
  });
}
