import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import type { ReactNode, Ref } from "react";

export function DisclosureLine({
  ref,
  itemKey,
  wrapClass,
  open,
  iconSize = 15,
  summary,
  children,
}: {
  readonly ref?: Ref<HTMLDetailsElement>;
  readonly itemKey?: string;
  readonly wrapClass?: string;
  readonly open?: boolean;
  readonly iconSize?: number;
  readonly summary: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <details
      ref={ref}
      className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
      open={open}
      data-item-key={itemKey}
    >
      <summary>
        <ChevronRightIcon width={iconSize} height={iconSize} className="ev-proc-chev" />
        {summary}
      </summary>
      {children}
    </details>
  );
}
