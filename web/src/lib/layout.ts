/**
 * Column-width math for the shell's sashes and the drawers' swipe-to-dismiss. Pure functions:
 * `AppShell.vue` feeds them pointer input and stores what they return.
 */
export type ColumnSpec = { min: number; max: number; default: number };

/** Base-pixel column limits: the numbers at the default interface size. Every public function
 *  takes a `scale` (text size / 14) — geometry grows with the interface, stored widths stay px. */
export const SIDE: ColumnSpec = { min: 212, max: 420, default: 264 };
export const RAIL: ColumnSpec = { min: 280, max: 560, default: 340 };
export const WORKER_RAIL: ColumnSpec = { min: 360, max: Number.POSITIVE_INFINITY, default: 540 };
export const MAIN_MIN = 420;

/** ArrowLeft/ArrowRight on a focused sash moves the boundary by this much. */
export const SASH_STEP = 16;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** A column's limits at an interface scale; `1` returns the base pixels untouched. */
export function scaledColumn(spec: ColumnSpec, scale: number): ColumnSpec {
  return { min: spec.min * scale, max: spec.max * scale, default: spec.default * scale };
}

/**
 * The width a column gets for a proposed width: its own scaled limits, and what is left once the
 * other side column and the scaled main minimum are paid for. `otherW` is the rendered width of
 * the other column, or 0 when collapsed/offcanvas or in drawer mode. When the viewport cannot
 * even meet the scaled `spec.min`, the main keeps its share and the column comes back under min.
 */
function fitColumn(
  proposed: number,
  spec: ColumnSpec,
  viewport: number,
  otherW: number,
  scale: number,
): number {
  const cap = Math.min(spec.max, viewport - otherW - MAIN_MIN * scale);
  return Math.round(Math.min(Math.max(proposed, spec.min), cap));
}

/**
 * Where a sidebar drag lands: the width clamps into range. Collapsing offcanvas only happens
 * through the sidebar toggle button or shortcut, never through a drag.
 */
export function fitSidebar(proposed: number, viewport: number, railW: number, scale = 1): number {
  return fitColumn(proposed, scaledColumn(SIDE, scale), viewport, railW, scale);
}

/** The rail width for a proposed width; `sideW` is the sidebar's rendered width (0 when collapsed). */
export function fitRail(
  proposed: number,
  viewport: number,
  sideW: number,
  scale = 1,
  spec = RAIL,
): number {
  return fitColumn(proposed, scaledColumn(spec, scale), viewport, sideW, scale);
}

/** A persisted width: garbage reads as the default, a number clamps into the scaled range. */
export function readWidth(raw: string | null, spec: ColumnSpec, scale = 1): number {
  const scaled = scaledColumn(spec, scale);
  const value = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return scaled.default;
  return Math.round(clamp(value, scaled.min, scaled.max));
}

/**
 * Whether a touch-dragged drawer closes on release: dragged past 35% of its width toward the edge,
 * or flicked at over 0.5px/ms. `drag` and `velocity` are positive toward the dismiss edge.
 */
export function dismissDrawer(drag: number, width: number, velocity: number): boolean {
  return drag > 0.35 * width || velocity > 0.5;
}

/** The overlay's opacity while a drawer is being dragged away: full at rest, gone at its width. */
export function drawerFade(drag: number, width: number): number {
  return clamp(1 - drag / width, 0, 1);
}
