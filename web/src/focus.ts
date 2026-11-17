import { nextTick, watch } from "vue";
import { tabStep } from "./keyboard.ts";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

/** Focuses the first focusable element inside `root`, or `root` itself when it has none; returns `root`. */
export function focusFirst(root: HTMLElement | undefined): HTMLElement | undefined {
  (root && (focusables(root)[0] ?? root))?.focus();
  return root;
}

/** Keeps Tab and Shift+Tab cycling inside `root`, for a modal dialog. */
export function trapTab(event: KeyboardEvent, root: HTMLElement | undefined): void {
  if (event.key !== "Tab" || !root) return;
  const items = focusables(root);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Remembers what had focus when `active()` turns true and gives focus back when it turns false, so closing a dialog
 * or drawer returns the keyboard user to where they were. `open()` runs after the DOM update and returns the panel it
 * moved focus into; focus still inside that panel when it closes (a drawer that is sliding out) counts as lost too.
 */
export function useFocusReturn(active: () => boolean, open: () => HTMLElement | undefined): void {
  let opener: HTMLElement | undefined;
  let panel: HTMLElement | undefined;
  watch(active, async (isActive, wasActive) => {
    if (isActive && !wasActive) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      await nextTick();
      panel = open();
    } else if (!isActive && wasActive) {
      const target = opener;
      const closing = panel;
      opener = undefined;
      panel = undefined;
      await nextTick();
      // A click elsewhere already moved focus on purpose; leave that alone.
      const current = document.activeElement;
      const lost = current === null || current === document.body || closing?.contains(current);
      if (lost && target?.isConnected) target.focus();
    }
  });
}

/**
 * Keyboard support for a `role="tablist"` or `role="radiogroup"` whose items use a roving `tabindex`: arrow keys,
 * Home and End select a neighbouring item and move focus to it.
 */
export function onRovingKeydown<K>(
  event: KeyboardEvent,
  keys: readonly K[],
  current: K,
  select: (key: K) => void,
): void {
  const next = tabStep(event.key, keys.indexOf(current), keys.length);
  if (next === undefined) return;
  event.preventDefault();
  select(keys[next] as K);
  const list = event.currentTarget as HTMLElement;
  void nextTick().then(() =>
    list.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"]')?.focus(),
  );
}
