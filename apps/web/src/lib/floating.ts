export type PopoverAnchorRect = {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
};

export type PopoverViewport = {
  readonly width: number;
  readonly height: number;
};

export type PopoverPlacement = "up" | "down";
export type PopoverAlign = "start" | "end";

export type ComputedPopoverPosition = {
  readonly placement: PopoverPlacement;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly top?: number;
  readonly bottom?: number;
};

export type SubmenuSide = "right" | "left";

export type SubmenuParentRect = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
};

export type ComputedSubmenuPosition = {
  readonly side: SubmenuSide;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
};

export type Point2D = {
  readonly x: number;
  readonly y: number;
};

const MIN_POPOVER_WIDTH = 220;
const MIN_POPOVER_HEIGHT = 140;

export function computePopoverPosition({
  anchor,
  viewport,
  preferredPlacement,
  preferredAlign,
  popoverWidth,
  estimatedHeight,
  offset = 6,
  margin = 12,
}: {
  readonly anchor: PopoverAnchorRect;
  readonly viewport: PopoverViewport;
  readonly preferredPlacement: PopoverPlacement;
  readonly preferredAlign: PopoverAlign;
  readonly popoverWidth: number;
  readonly estimatedHeight: number;
  readonly offset?: number;
  readonly margin?: number;
}): ComputedPopoverPosition {
  const spaceAbove = Math.max(0, anchor.top - margin - offset);
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - margin - offset);

  let placement: PopoverPlacement = preferredPlacement;
  if (preferredPlacement === "down") {
    if (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) {
      placement = "up";
    }
  } else if (spaceAbove < estimatedHeight && spaceBelow > spaceAbove) {
    placement = "down";
  }

  const maxAvailableWidth = Math.max(0, viewport.width - margin * 2);
  const width =
    maxAvailableWidth < MIN_POPOVER_WIDTH
      ? maxAvailableWidth
      : Math.min(popoverWidth, maxAvailableWidth);

  const rawLeft = preferredAlign === "end" ? anchor.right - width : anchor.left;
  const maxLeft = Math.max(margin, viewport.width - margin - width);
  const left = Math.max(margin, Math.min(rawLeft, maxLeft));

  if (placement === "up") {
    const bottom = Math.max(margin, viewport.height - anchor.top + offset);
    const maxHeight = Math.max(
      MIN_POPOVER_HEIGHT,
      Math.floor(Math.min(viewport.height - margin * 2, viewport.height - bottom - margin)),
    );
    return { placement, left, width, maxHeight, bottom };
  }

  const top = Math.max(margin, anchor.bottom + offset);
  const maxHeight = Math.max(
    MIN_POPOVER_HEIGHT,
    Math.floor(Math.min(viewport.height - margin * 2, viewport.height - top - margin)),
  );
  return { placement, left, width, maxHeight, top };
}

export function computeSubmenuPosition({
  parent,
  rowTop,
  submenuWidth,
  estimatedHeight,
  viewport,
  gap = 6,
  margin = 12,
  alignOffset = 6,
}: {
  readonly parent: SubmenuParentRect;
  readonly rowTop: number;
  readonly submenuWidth: number;
  readonly estimatedHeight: number;
  readonly viewport: PopoverViewport;
  readonly gap?: number;
  readonly margin?: number;
  readonly alignOffset?: number;
}): ComputedSubmenuPosition | undefined {
  const rightLeft = parent.right + gap;
  const leftLeft = parent.left - gap - submenuWidth;

  let side: SubmenuSide;
  let left: number;
  if (rightLeft + submenuWidth <= viewport.width - margin) {
    side = "right";
    left = rightLeft;
  } else if (leftLeft >= margin) {
    side = "left";
    left = leftLeft;
  } else {
    return undefined;
  }

  const maxHeight = Math.max(120, Math.floor(viewport.height - margin * 2));
  const clampedHeight = Math.min(estimatedHeight, maxHeight);
  const rawTop = rowTop - alignOffset;
  const maxTop = Math.max(margin, viewport.height - margin - clampedHeight);
  const top = Math.max(margin, Math.min(rawTop, maxTop));

  return { side, left, top, width: submenuWidth, maxHeight };
}

function cross(a: Point2D, b: Point2D, c: Point2D): number {
  return (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
}

export function isPointInSafeTriangle(
  point: Point2D,
  origin: Point2D,
  target: SubmenuParentRect,
  side: SubmenuSide,
  verticalPad = 14,
): boolean {
  const nearX = side === "right" ? target.left : target.right;
  if (side === "right" && (origin.x >= nearX || point.x <= origin.x)) return false;
  if (side === "left" && (origin.x <= nearX || point.x >= origin.x)) return false;

  const b: Point2D = { x: nearX, y: target.top - verticalPad };
  const c: Point2D = { x: nearX, y: target.bottom + verticalPad };
  const d1 = cross(point, origin, b);
  const d2 = cross(point, b, c);
  const d3 = cross(point, c, origin);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
