/** Class lists for stacked rows: a bordered list of rows, each with a title and a note under it. */

const SEPARATED = "[&>*+*]:border-t [&>*+*]:border-separator";

/** The list. `plain` drops the frame; `spaced` sets the rows apart instead of drawing lines between them. */
export function rows(options: { plain?: boolean; spaced?: boolean } = {}): string {
  if (options.spaced) return "flex flex-col gap-2";
  if (options.plain) return `flex flex-col ${SEPARATED}`;
  return `flex flex-col rounded-lg border border-border bg-surface [--ev-glyph-cut:var(--surface)] ${SEPARATED}`;
}

const ROW_SIZE = {
  md: "min-h-13 gap-3 px-4 py-2.5",
  sm: "min-h-11 gap-3 px-4 py-2.5",
  sect: "gap-3 px-4 pt-3.5 pb-1",
  home: "min-h-17 gap-3 rounded-md px-3 py-3.5",
  none: "",
};

/**
 * A row. `link` makes the whole row the link; `overlay` is a row whose `.row-link` covers it while
 * its other controls stay above.
 */
export function row(
  options: { size?: keyof typeof ROW_SIZE; link?: boolean; overlay?: boolean } = {},
): string {
  const size = options.size ?? "md";
  const parts = ["flex items-center", ROW_SIZE[size]];
  if (options.link || options.overlay) {
    parts.push(
      "text-inherit no-underline transition-colors hover:bg-hover focus-visible:shadow-(--ring) focus-visible:outline-none [&_.go]:text-fg-subtle",
    );
    if (size !== "home") parts.push("first:rounded-t-lg last:rounded-b-lg only:rounded-lg");
  }
  if (options.overlay) parts.push("relative [&>:not(.row-link)]:relative [&>:not(.row-link)]:z-1");
  return parts.join(" ");
}

/** A row that picks an item: a checkbox or a chevron at its edge; `.off` once it can't be picked. */
export const ROW_PICK =
  "flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-1.5 text-left hover:bg-hover [&.off]:cursor-default [&.off]:opacity-60 [&>input]:size-4 [&>input]:flex-none [&>input]:accent-(--accent)";

/** The link covering an `overlay` row. */
export const ROW_LINK =
  "row-link rounded-sm text-inherit no-underline after:absolute after:inset-0 after:content-[''] focus-visible:shadow-(--ring) focus-visible:outline-none";

export function rowMain(options: { loose?: boolean } = {}): string {
  return [
    "flex min-w-0 flex-1 flex-col [&_.err]:text-xs [&_.err]:break-words [&_.err]:whitespace-pre-wrap [&_.err]:text-danger",
    options.loose ? "gap-1.25" : "gap-0.5",
  ].join(" ");
}

/** The title. `muted` heads a group of rows; `block` lets one line ellipsize; `clamp` allows two. */
export function rowTitle(
  options: { muted?: boolean; block?: boolean; clamp?: boolean } = {},
): string {
  const layout = options.clamp
    ? "line-clamp-2 leading-[1.5]"
    : options.block
      ? "block"
      : "flex flex-wrap items-center gap-1.5";
  const text = options.muted ? "text-xs text-fg-subtle" : "text-base";
  return `${layout} ${text} font-medium tracking-(--ev-tracking)`;
}

export const ROW_DESC = "text-xs leading-[1.333] text-fg-muted";
