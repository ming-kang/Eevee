/** Class lists for floating menus and lists: the panel, its rows, group labels and the empty note. */

export function menuPanel(options: { animate?: boolean } = {}): string {
  return [
    "pop absolute z-30 rounded-lg border border-border bg-(--ev-glass-bg) p-1 shadow-md backdrop-blur-(--ev-glass-blur) backdrop-saturate-(--ev-glass-sat)",
    options.animate === false ? "" : "animate-[ev-rise_var(--ev-regular)_var(--ev-ease)]",
  ].join(" ");
}

const ROW_SIZE = { md: "h-8.5", sm: "h-8", auto: "min-h-8.5 py-1.25" };

/** A row the pointer and the arrows highlight at once (`.sel`); a fade would trail behind them. */
export function menuRow(size: keyof typeof ROW_SIZE = "md"): string {
  return [
    "pop-row flex w-full items-center gap-2.5 rounded-md px-2.5 text-left text-base tracking-(--ev-tracking) text-fg hover:bg-hover [&.sel]:bg-hover [&>.glyph]:text-fg-muted [&>.ico]:text-fg-muted [&_.meta]:flex-none [&_.meta]:text-xs [&_.meta]:text-fg-subtle",
    ROW_SIZE[size],
  ].join(" ");
}

export const MENU_GROUP = "px-2.5 pt-2.5 pb-1 text-xs font-medium text-fg-subtle first:pt-1";
export const MENU_EMPTY = "px-4 py-7 text-center text-sm text-fg-subtle";
