import type { Directive } from "vue";
import { isAtEnd, type Modality, modalityOfKey, pillGeometry } from "./dom-rules.ts";

const CHOSEN =
  ":scope > button.on, :scope > [aria-selected='true'], :scope > [aria-pressed='true']";
const observers = new WeakMap<HTMLElement, ResizeObserver>();

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
    const observer = new ResizeObserver(() => place(el));
    observer.observe(el);
    observers.set(el, observer);
  },
  updated(el) {
    place(el);
  },
  unmounted(el) {
    observers.get(el)?.disconnect();
    observers.delete(el);
  },
};

const following = new WeakMap<HTMLElement, boolean>();

function toEnd(el: HTMLElement): void {
  if (following.get(el) !== false) el.scrollTop = el.scrollHeight;
}

function onTailScroll(this: HTMLElement): void {
  following.set(this, isAtEnd(this));
}

/**
 * `v-tail` on a scroller of growing output (a job log): it opens at the newest line and keeps
 * following new lines, until the reader scrolls up to look at something; scrolling back to the
 * bottom resumes it.
 */
export const vTail: Directive<HTMLElement> = {
  mounted(el) {
    el.addEventListener("scroll", onTailScroll, { passive: true });
    toEnd(el);
    requestAnimationFrame(() => toEnd(el));
  },
  updated(el) {
    toEnd(el);
  },
  unmounted(el) {
    el.removeEventListener("scroll", onTailScroll);
    following.delete(el);
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
