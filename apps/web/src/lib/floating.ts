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
