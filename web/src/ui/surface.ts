/** Class lists for the plain surfaces and marks the pages share. */

/** A bordered surface holding a table, a form or a block of text. */
export const PANEL =
  "overflow-hidden rounded-xl border border-border bg-surface [--ev-glyph-cut:var(--surface)]";

/** A small label beside a title: a kind, a count, a state. */
export function badge(options: { mono?: boolean } = {}): string {
  return [
    "inline-flex h-5 items-center gap-1 rounded-xs bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] px-1.5 leading-none font-medium whitespace-nowrap text-fg tabular-nums",
    options.mono ? "text-2xs" : "text-xs",
  ].join(" ");
}

/** A note across the top of a page; `danger` for problems that need attention. */
export function banner(tone?: "danger"): string {
  return [
    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-[1.385] [&_ul]:mt-1 [&_ul]:pl-4.5 [&>.ico]:mt-px",
    tone === "danger"
      ? "border-[color-mix(in_oklab,var(--danger)_30%,var(--border))] bg-[color-mix(in_oklab,var(--surface)_93%,var(--danger))] [&>.ico]:text-danger"
      : "border-border bg-surface [&>.ico]:text-fg-muted",
  ].join(" ");
}

export const ERROR_TEXT = "px-3.5 pt-0.5 pb-2 text-xs text-(color:--ev-bad-ink)";

/** A one-line command in a code well, with room for a copy button on its right. */
export const CODELINE =
  "flex min-h-(--ev-h-md) items-center gap-1 rounded-md border border-border bg-(--ev-code) py-0.5 pr-0.5 pl-2.5 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap";

/** A data table inside a panel; `td.r` aligns numbers right, `tr.row-link` rows open something. */
export const TABLE =
  "w-full border-separate border-spacing-0 text-sm [&_th]:h-9 [&_th]:border-b [&_th]:border-separator [&_th]:px-3.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-fg-muted [&_td]:h-11 [&_td]:border-b [&_td]:border-separator [&_td]:px-3.5 [&_tbody_tr:last-child_td]:border-b-0 [&_td.mono]:whitespace-nowrap [&_td.name]:whitespace-nowrap [&_td.r]:text-right [&_td.r]:tabular-nums [&_tr.row-link]:cursor-pointer hover:[&_tr.row-link:hover_td]:bg-hover";

export const SECTION_H = "mt-6.5 mb-2.5 text-xs font-medium text-fg-muted first:mt-0";

/** A centered empty state: an `h3`, an optional `p` and an action. */
export const EMPTY =
  "flex flex-1 flex-col items-center justify-center gap-2.5 px-6 py-12 text-center text-fg-muted [&_:is(button,a)]:mt-1.5 [&_h3]:text-(length:--ev-headline) [&_h3]:font-medium [&_h3]:tracking-[-0.015em] [&_h3]:text-fg [&_p]:text-sm [&_p]:text-fg-subtle";
