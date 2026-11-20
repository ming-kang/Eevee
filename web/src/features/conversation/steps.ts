/** Class lists for the steps a folded process line opens into. */

export const STEPS = "mt-1 mb-2 ml-5.5 flex min-w-0 flex-col gap-1";

export const STEP_ROW =
  "flex min-h-6 min-w-0 items-center gap-1.5 text-sm text-fg-subtle [&>.ico]:size-4 [&_.arg]:flex-1 [&_.arg]:font-mono [&_.arg]:text-xs [&_.ms]:ml-auto [&_.ms]:flex-none [&_.ms]:text-xs [&_.ms]:text-fg-subtle [&_.ms]:tabular-nums [&_.tool]:flex-none [&_.tool]:font-mono [&_.tool]:text-xs [&_.tool]:leading-none [&_.tool]:font-medium [&_.tool]:text-fg-muted";

export const STEP_NOTE = "pb-1 text-xs whitespace-pre-wrap text-fg-subtle";

export const STEP_OUT =
  "step-out mt-0.5 mb-1.5 max-h-70 overflow-auto rounded-lg border border-border bg-(--ev-code) px-3 py-2.5 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-fg [.proc>&]:ml-3.25";
