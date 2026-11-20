/** Class list for a line diff: `.ln` rows of line numbers, a `.mk` marker and the text, `.hunk` headers. */
export function diff(options: { single?: boolean; framed?: boolean } = {}): string {
  return [
    "overflow-x-auto font-mono text-xs leading-[1.65]",
    "[&_.ln]:grid [&_.ln]:min-w-max [&_.ln]:whitespace-pre",
    options.single
      ? "[&_.ln]:grid-cols-[calc(40px*var(--ev-scale))_calc(18px*var(--ev-scale))_minmax(0,1fr)]"
      : "[&_.ln]:grid-cols-[calc(40px*var(--ev-scale))_calc(40px*var(--ev-scale))_calc(18px*var(--ev-scale))_minmax(0,1fr)]",
    "[&_.ln>span:not(:last-child,.mk)]:pr-2 [&_.ln>span:not(:last-child,.mk)]:text-right [&_.ln>span:not(:last-child,.mk)]:text-fg-subtle [&_.ln>span:not(:last-child,.mk)]:select-none [&_.ln>span:last-child]:pr-3.5",
    "[&_.mk]:text-center [&_.mk]:text-fg-subtle [&_.mk]:select-none [&_.add]:bg-(--ev-add) [&_.add_.mk]:text-success [&_.del]:bg-(--ev-del) [&_.del_.mk]:text-danger",
    "[&_.hunk]:bg-[color-mix(in_oklab,var(--fg)_3%,transparent)] [&_.hunk]:px-3.5 [&_.hunk]:py-1 [&_.hunk]:text-fg-subtle",
    options.framed
      ? "mt-0.5 mb-1.5 ml-3.25 max-h-80 overflow-auto rounded-lg border border-border bg-(--ev-code)"
      : "",
  ].join(" ");
}

export const DIFFSTAT = "inline-flex gap-1.25 font-mono text-xs leading-none";
