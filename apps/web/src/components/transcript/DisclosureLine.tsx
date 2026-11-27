import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { ProgressiveDisclosure } from "@earendil-works/elanor-react";
import { type ReactNode, type Ref, useState } from "react";
import { useAutoExpandDisclosure } from "./useAutoExpandDisclosure.ts";

export function DisclosureLine({
  ref,
  itemKey,
  wrapClass,
  open,
  live,
  forceOpen,
  onOpenChange,
  iconSize = 15,
  summary,
  children,
}: {
  readonly ref?: Ref<HTMLDivElement>;
  readonly itemKey?: string;
  readonly wrapClass?: string;
  readonly open?: boolean;
  readonly live?: boolean;
  readonly forceOpen?: boolean;
  readonly onOpenChange?: (nextOpen: boolean) => void;
  readonly iconSize?: number;
  readonly summary: ReactNode;
  readonly children?: ReactNode;
}) {
  const controlled = onOpenChange !== undefined;
  const [autoOpen, setAutoOpen] = useAutoExpandDisclosure(Boolean(live), {
    initialOpen: open ?? (Boolean(live) || Boolean(forceOpen)),
    forceOpen,
  });
  const [plainOpen, setPlainOpen] = useState(Boolean(open));

  const useAuto = !controlled && (live !== undefined || forceOpen !== undefined);
  const isOpen = controlled ? Boolean(open) : useAuto ? autoOpen : plainOpen;

  const handleOpenChange = (next: boolean) => {
    if (controlled) onOpenChange(next);
    else if (useAuto) setAutoOpen(next);
    else setPlainOpen(next);
  };

  return (
    <ProgressiveDisclosure.Root
      ref={ref}
      className={`ev-proc${wrapClass ? ` ${wrapClass}` : ""}`}
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-item-key={itemKey}
    >
      <ProgressiveDisclosure.Trigger className="ev-proc-trigger">
        <ChevronRightIcon width={iconSize} height={iconSize} className="ev-proc-chev" />
        {summary}
      </ProgressiveDisclosure.Trigger>
      {children ? (
        <ProgressiveDisclosure.Panel className="ev-proc-panel">
          <div className="ev-proc-panel-inner">{children}</div>
        </ProgressiveDisclosure.Panel>
      ) : null}
    </ProgressiveDisclosure.Root>
  );
}
