/** The interface size every type role and icon is a ratio of (`--ev-ui`), in whole pixels. */
export const TEXT_SIZE = { min: 12, max: 20, default: 14 } as const;
export const TEXT_SIZE_KEY = "eevee.textSize";
export const FONT_KEY = "eevee.font";

/** A size the reader typed or stored, or undefined when it is not a whole number in range. */
export function readTextSize(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return undefined;
  const size = Number(value);
  return size >= TEXT_SIZE.min && size <= TEXT_SIZE.max ? size : undefined;
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/**
 * The font-family list for the fonts the reader typed, comma separated: each name quoted, ahead of
 * the bundled stack (`--ev-font-base`) so a missing font or glyph still lands on it. Blank means the
 * bundled stack alone.
 */
export function fontStack(input: string): string | undefined {
  const names = input
    .split(",")
    .map((name) =>
      name
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim(),
    )
    .filter((name) => name !== "");
  if (names.length === 0) return undefined;
  const families = names.map((name) =>
    GENERIC_FAMILIES.has(name.toLowerCase())
      ? name.toLowerCase()
      : `"${name.replace(/["\\]/g, "\\$&")}"`,
  );
  return `${families.join(", ")}, var(--ev-font-base)`;
}
