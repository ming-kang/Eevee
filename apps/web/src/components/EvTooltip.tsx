import { Tooltip } from "@earendil-works/elanor-react";
import type { ReactElement, ReactNode } from "react";

export type EvTooltipProps = {
  readonly content: ReactNode;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly sideOffset?: number;
  readonly disabled?: boolean;
  readonly children: ReactElement;
};

export function EvTooltip({
  content,
  side = "top",
  align = "center",
  sideOffset = 6,
  disabled = false,
  children,
}: EvTooltipProps) {
  if (!content || disabled) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner
          className="ev-tooltip-positioner"
          side={side}
          align={align}
          sideOffset={sideOffset}
        >
          <Tooltip.Popup className="ev-tooltip-popup">{content}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
