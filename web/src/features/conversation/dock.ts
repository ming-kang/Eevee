/** Class lists for the dock under a conversation: the composer stack and the notes around it. */

export const DOCK =
  "flex-none px-(--ev-gutter) pb-4 @max-[54.2857em]/vp:px-3 @max-[54.2857em]/vp:pb-3 in-[.landing]:mb-auto in-[.landing]:pb-[12vh] has-[.qcard]:min-h-0 has-[.qcard]:shrink has-[.qcard]:scroll-py-3 has-[.qcard]:overflow-y-auto has-[.qcard]:overscroll-y-contain";

export const DOCK_INNER = "mx-auto flex max-w-(--ev-chat-max) flex-col gap-2";

export const DOCK_NOTE = "py-1.5 text-center text-xs text-fg-subtle";

export const COMPOSER_STACK =
  "flex flex-col rounded-panel border-0 bg-surface shadow-soft transition-shadow duration-(--ev-regular) focus-within:shadow-[var(--elev-soft),0_0_0_2px_var(--accent-soft)]";
