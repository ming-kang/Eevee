/** The interface sizes a reader can pick. Every type role and icon is a ratio of it (`--ev-ui`). */
export const TEXT_SIZES = [13, 14, 15, 16] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DEFAULT_TEXT_SIZE: TextSize = 14;
export const TEXT_SIZE_KEY = "eevee.textSize";

/** The stored preference, or the default when it is missing or not one of the sizes. */
export function parseTextSize(stored: string | null): TextSize {
  const value = Number(stored);
  return TEXT_SIZES.find((size) => size === value) ?? DEFAULT_TEXT_SIZE;
}
