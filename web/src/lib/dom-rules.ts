/** The decisions behind `dom.ts`, kept free of the DOM so they can be tested. */

type SegmentBox = { left: number; width: number; chosen: boolean };

/** Where the sliding pill of a segmented strip stands: over the chosen button, or nowhere. */
export function pillGeometry(
  boxes: readonly SegmentBox[],
): { x: number; width: number } | undefined {
  const chosen = boxes.find((box) => box.chosen);
  return chosen ? { x: chosen.left, width: chosen.width } : undefined;
}

type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** A scroller counts as following its end when it sits within `slack` pixels of the bottom. */
export function isAtEnd(box: ScrollBox, slack = 8): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

export type Modality = "keyboard" | "pointer";

/** Keys that move focus or a selection; Enter, Space and Escape act rather than navigate. */
const MOVES = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * What a key press says about how the person is getting around: navigating keys outside a text
 * field mean the keyboard (Tab always does); typing, shortcuts and acting keys say nothing.
 */
export function modalityOfKey(
  key: string,
  context: { modifier: boolean; inTextEntry: boolean },
): Modality | undefined {
  if (context.modifier || !MOVES.has(key)) return undefined;
  if (context.inTextEntry && key !== "Tab") return undefined;
  return "keyboard";
}
