import type { Directive } from "vue";
import { isAtEnd, type Modality, modalityOfKey, pillGeometry } from "../lib/dom-rules.ts";

const CHOSEN =
  ":scope > button.on, :scope > [aria-selected='true'], :scope > [aria-pressed='true']";
const observers = new WeakMap<HTMLElement, ResizeObserver>();
const sashEndSubs = new WeakMap<HTMLElement, () => void>();

const SASH_DRAG_END = "eevee:sash-drag-end";

/** Whether a column sash is mid-drag: `Sash.vue` puts `ev-sash-drag` on `<html>` for it. */
export function isSashDragging(): boolean {
  return document.documentElement.classList.contains("ev-sash-drag");
}

/** `Sash.vue` broadcasts this once a pointer drag finishes or is cancelled. */
export function announceSashDragEnd(): void {
  document.dispatchEvent(new Event(SASH_DRAG_END));
}

/**
 * Runs `cb` at each sash drag's end; returns an unsubscribe. Listeners that skip layout reads
 * while `isSashDragging()` use it to do the one measure they deferred.
 */
export function onSashDragEnd(cb: () => void): () => void {
  const handler = () => cb();
  document.addEventListener(SASH_DRAG_END, handler);
  return () => document.removeEventListener(SASH_DRAG_END, handler);
}

function place(el: HTMLElement): void {
  let pill = el.querySelector<HTMLElement>(":scope > .seg-pill");
  if (!pill) {
    pill = document.createElement("span");
    pill.className = "seg-pill";
    pill.setAttribute("aria-hidden", "true");
    el.prepend(pill);
  }
  const chosen = el.querySelector<HTMLElement>(CHOSEN);
  const boxes = [...el.querySelectorAll<HTMLElement>(":scope > button")].map((button) => ({
    left: button.offsetLeft,
    width: button.offsetWidth,
    chosen: button === chosen,
  }));
  const geometry = pillGeometry(boxes);
  pill.style.opacity = geometry ? "1" : "0";
  if (geometry) {
    pill.style.width = `${geometry.width}px`;
    pill.style.transform = `translateX(${geometry.x}px)`;
  }
  // The first placement lands without travel; from then on the pill slides.
  if (!el.classList.contains("measured")) requestAnimationFrame(() => el.classList.add("measured"));
}

/**
 * `v-seg` on a `.seg` strip: one pill stands under the chosen button (`.on`, `aria-selected`, or
 * `aria-pressed`) and slides when the choice changes, instead of each button carrying a fill.
 */
export const vSeg: Directive<HTMLElement> = {
  mounted(el) {
    place(el);
    // A sash drag resizes the pill's strip every frame; the reads wait for the drag's end.
    const observer = new ResizeObserver(() => {
      if (!isSashDragging()) place(el);
    });
    observer.observe(el);
    observers.set(el, observer);
    sashEndSubs.set(
      el,
      onSashDragEnd(() => place(el)),
    );
  },
  updated(el) {
    if (!isSashDragging()) place(el);
  },
  unmounted(el) {
    observers.get(el)?.disconnect();
    observers.delete(el);
    sashEndSubs.get(el)?.();
    sashEndSubs.delete(el);
  },
};

/**
 * Follow-the-end mechanics behind `v-tail` and the transcript's scroller: the scroller opens at the
 * newest line and `toEnd` keeps it there, until the reader scrolls up to look at something;
 * scrolling back to the bottom resumes it. `onChange` hears every change of that.
 */
export type FollowEnd = {
  /** Whether the scroller still counts as following; writable to re-follow without a scroll. */
  following: boolean;
  /** Jumps to the end while following. */
  toEnd(): void;
  /** Stops listening. */
  detach(): void;
};

export function followEnd(el: HTMLElement, onChange?: (following: boolean) => void): FollowEnd {
  let following = true;
  const onScroll = () => {
    following = isAtEnd(el);
    onChange?.(following);
  };
  const toEnd = () => {
    if (following) el.scrollTop = el.scrollHeight;
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  el.scrollTop = el.scrollHeight;
  // Fonts and code blocks can still change heights after the first frame.
  requestAnimationFrame(toEnd);
  return {
    get following() {
      return following;
    },
    set following(yes: boolean) {
      following = yes;
    },
    toEnd,
    detach() {
      el.removeEventListener("scroll", onScroll);
    },
  };
}

const tails = new WeakMap<HTMLElement, FollowEnd>();

/**
 * `v-tail` on a scroller of growing output (a job log): it opens at the newest line and keeps
 * following new lines, until the reader scrolls up to look at something; scrolling back to the
 * bottom resumes it.
 */
export const vTail: Directive<HTMLElement> = {
  mounted(el) {
    tails.set(el, followEnd(el));
  },
  updated(el) {
    tails.get(el)?.toEnd();
  },
  unmounted(el) {
    tails.get(el)?.detach();
    tails.delete(el);
  },
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !/^(button|checkbox|radio|range|submit|reset|color|file)$/.test(target.type)
  );
}

/**
 * Draw focus rings only for someone navigating by keyboard. `:focus-visible` guesses from the last
 * input of any kind, so focus a dialog hands back after a click lights up as if tabbed to. This
 * publishes `data-modality` on `<html>`; the tokens zero the ring width while it is `pointer`.
 */
export function trackFocusModality(doc: Document = document): void {
  const root = doc.documentElement;
  const set = (next: Modality) => {
    if (root.dataset.modality !== next) root.dataset.modality = next;
  };
  set("pointer");
  doc.addEventListener("pointerdown", () => set("pointer"), true);
  doc.addEventListener(
    "keydown",
    (event) => {
      const next = modalityOfKey(event.key, {
        modifier: event.metaKey || event.ctrlKey || event.altKey,
        inTextEntry: isTextEntry(event.target),
      });
      if (next) set(next);
    },
    true,
  );
}
