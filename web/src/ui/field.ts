/** The look shared by text inputs, selects and text areas. */
export function fieldClass(
  options: { mono?: boolean; size?: "sm" | "md"; multiline?: boolean; inline?: boolean } = {},
): string {
  return [
    "border border-border-strong bg-surface px-2.5 text-fg transition-[border-color,box-shadow] focus:border-accent focus:shadow-[var(--ring-field)] focus-visible:shadow-[var(--ring-field)] disabled:opacity-45",
    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
    options.multiline
      ? "min-h-18 resize-y rounded-lg py-2 leading-normal"
      : options.size === "sm"
        ? "h-7 rounded-sm"
        : "h-8 rounded-md",
    options.mono ? "font-mono text-xs" : "text-sm",
    options.inline ? "" : "w-full",
  ].join(" ");
}
