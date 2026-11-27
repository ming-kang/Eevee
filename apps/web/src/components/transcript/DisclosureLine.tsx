import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import type { ReactNode } from "react";

export function DisclosureLine({
  itemKey,
  editKey,
  wrapClass,
  open,
  iconSize = 15,
  summary,
  children,
}: {
  readonly itemKey?: string;
  readonly editKey?: string;
  readonly wrapClass?: string;
  readonly open?: boolean;
  readonly iconSize?: number;
  readonly summary: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <details
      className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
      open={open}
      data-item-key={itemKey}
      data-edit-key={editKey}
    >
      <summary>
        <ChevronRightIcon width={iconSize} height={iconSize} className="ev-proc-chev" />
        {summary}
      </summary>
      {children}
    </details>
  );
}
