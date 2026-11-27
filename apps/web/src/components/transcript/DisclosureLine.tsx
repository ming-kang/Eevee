import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { ProgressiveDisclosure } from "@earendil-works/elanor-react";
import { type ReactNode, type Ref, useEffect, useState } from "react";

export function DisclosureLine({
  ref,
  itemKey,
  wrapClass,
  open,
  onOpenChange,
  iconSize = 15,
  summary,
  children,
}: {
  readonly ref?: Ref<HTMLDivElement>;
  readonly itemKey?: string;
  readonly wrapClass?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (nextOpen: boolean) => void;
  readonly iconSize?: number;
  readonly summary: ReactNode;
  readonly children?: ReactNode;
}) {
  const controlled = onOpenChange !== undefined;
  const [internalOpen, setInternalOpen] = useState(Boolean(open));

  useEffect(() => {
    if (!controlled && open !== undefined) {
      setInternalOpen(open);
    }
  }, [controlled, open]);

  const isOpen = controlled ? Boolean(open) : internalOpen;

  return (
    <ProgressiveDisclosure.Root
      ref={ref}
      className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
      open={isOpen}
      onOpenChange={(next) => {
        if (controlled) onOpenChange(next);
        else setInternalOpen(next);
      }}
      data-item-key={itemKey}
    >
      <ProgressiveDisclosure.Trigger className="ev-proc-trigger">
        <ChevronRightIcon width={iconSize} height={iconSize} className="ev-proc-chev" />
        {summary}
      </ProgressiveDisclosure.Trigger>
      {children ? (
        <ProgressiveDisclosure.Panel className="ev-proc-panel">
          {children}
        </ProgressiveDisclosure.Panel>
      ) : null}
    </ProgressiveDisclosure.Root>
  );
}
