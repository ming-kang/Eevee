/** Class lists for the steps a folded process line opens into. */

export const STEPS =
  "mt-0.5 mb-1.5 ml-3.25 flex flex-col gap-0.5 pl-3 shadow-[inset_1px_0_0_var(--ev-separator)]";

export const STEP_ROW =
  "flex min-h-6 items-center gap-2 text-xs text-fg-muted [&_.arg]:flex-1 [&_.ms]:ml-auto [&_.ms]:flex-none [&_.ms]:text-xs [&_.ms]:text-fg-subtle [&_.ms]:tabular-nums [&_.tool]:flex-none [&_.tool]:font-mono [&_.tool]:text-xs [&_.tool]:leading-none [&_.tool]:font-medium [&_.tool]:text-fg";

export const STEP_NOTE = "pb-1 text-xs whitespace-pre-wrap text-fg-subtle";

export const STEP_OUT =
  "step-out mt-0.5 mb-1.5 max-h-70 overflow-auto rounded-lg border border-border bg-(--ev-code) px-3 py-2.5 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-fg [.proc>&]:ml-3.25";
