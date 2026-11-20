/** Class lists for editor forms: a label on the left, the value holder on the right. */

const NARROW = "@max-[44.2857em]/vp:";

/** A form row; `top` aligns a tall control's label with its first line. */
export function formRow(options: { top?: boolean } = {}): string {
  return [
    `grid min-h-13 grid-cols-[calc(120px*var(--ev-scale))_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-2.5 ${NARROW}grid-cols-1`,
    "[&>label:not(.toggle)]:text-sm [&>label:not(.toggle)]:font-medium [&>label:not(.toggle)]:text-fg",
    "[&_.seg]:self-start [&_.seg]:justify-self-start [&_.seg+.f-note]:mt-0.5",
    options.top
      ? `items-start [&>.f-label]:pt-1.5 [&>label:not(.toggle)]:pt-1.5 ${NARROW}[&>.f-label]:pt-0 ${NARROW}[&>label:not(.toggle)]:pt-0`
      : "items-center",
  ].join(" ");
}

export const FORM_LABEL = "f-label text-sm font-medium text-fg";
export const FIELD_CTRL = "flex min-w-0 flex-col gap-1.5";
export const FIELD_INLINE = "flex items-center gap-2";
/** A note under a control; `.warn` when it points at a problem. */
export const FIELD_NOTE =
  "f-note text-xs leading-[1.4] wrap-anywhere text-fg-muted [&.warn]:text-danger";

/** A section title above a group of rows; a form tightens the gap above its `.section-t`. */
export const SECTION_T =
  "section-t mt-5 flex min-h-(--ev-h-sm) items-center gap-2 [&_.count]:font-medium [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:tracking-(--ev-tracking)";
export const FORM = "flex flex-col gap-3 [&>.section-t]:mt-2";
/** A stacked field: a small label over its control. */
export const FIELD =
  "field flex flex-col gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-fg-muted";
export const TOGGLE = "toggle inline-flex cursor-pointer items-center gap-2 text-sm text-fg";
/** A `details` whose summary leads with a chevron that turns down when open. */
export const DISCLOSURE =
  "[&>summary]:inline-flex [&>summary]:cursor-pointer [&>summary]:list-none [&>summary]:items-center [&>summary]:gap-1.5 [&>summary]:py-1 [&>summary]:text-sm [&>summary]:font-semibold [&>summary::-webkit-details-marker]:hidden [&>summary]:before:size-1.5 [&>summary]:before:-rotate-45 [&>summary]:before:border-r-[1.5px] [&>summary]:before:border-b-[1.5px] [&>summary]:before:border-current [&>summary]:before:transition-transform [&>summary]:before:duration-(--ev-fast) [&>summary]:before:content-[''] open:[&>summary]:before:rotate-45";
/** The form's actions, kept in reach at the bottom of the page while it scrolls. */
export const FORM_FOOT =
  "sticky bottom-0 z-2 mt-1 flex items-center gap-2 bg-(--ev-page) py-3 shadow-[0_-1px_0_var(--ev-separator)] [&_.error]:text-xs [&_.error]:whitespace-pre-wrap";
