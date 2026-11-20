/** Class lists for the reader's own messages and question answers. */

export function uWrap(pending = false): string {
  return [
    "u-wrap mt-5 mb-2.5 flex flex-col items-end gap-1 first:mt-0",
    pending ? "animate-[ev-rise_var(--ev-regular)_var(--ev-ease)]" : "",
  ].join(" ");
}

export function msgUser(pending = false): string {
  return [
    "msg-user max-w-[min(80%,calc(560px*var(--ev-scale)))] rounded-lg border border-[color-mix(in_oklab,var(--border)_65%,transparent)] bg-(--ev-msg-user) px-3.75 py-2.5 text-base leading-[1.572] whitespace-pre-wrap wrap-anywhere @max-[54.2857em]/vp:max-w-[88%]",
    pending ? "text-fg-muted" : "text-(color:--ev-prose)",
  ].join(" ");
}

export const MSG_META =
  "flex min-h-4 items-center gap-1.5 px-1 text-xs leading-[1.333] text-fg-subtle tabular-nums";
export const VIA = "mb-1 text-xs leading-[1.333] whitespace-normal text-fg-muted";
