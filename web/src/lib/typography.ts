export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const PALETTE_IDS = ["default", "grove", "ocean", "ember", "iris", "rose"] as const;
export type ThemePalette = (typeof PALETTE_IDS)[number];

export type PaletteSwatch = {
  id: ThemePalette;
  light: { canvas: string; sidebar: string; primary: string };
  dark: { canvas: string; sidebar: string; primary: string };
};

export const THEME_PALETTES: readonly PaletteSwatch[] = [
  {
    id: "default",
    light: { canvas: "#fcfcfc", sidebar: "#f5f5f7", primary: "#1b4ed8" },
    dark: { canvas: "#1e2127", sidebar: "#191c22", primary: "#346bf1" },
  },
  {
    id: "grove",
    light: { canvas: "#f5faf7", sidebar: "#ebf3ee", primary: "#15803d" },
    dark: { canvas: "#1b241f", sidebar: "#161e1a", primary: "#35b271" },
  },
  {
    id: "ocean",
    light: { canvas: "#f6f9fc", sidebar: "#edf3f8", primary: "#0369a1" },
    dark: { canvas: "#1b2329", sidebar: "#161d22", primary: "#08a4e5" },
  },
  {
    id: "ember",
    light: { canvas: "#fcf9f6", sidebar: "#f5efe9", primary: "#c2410c" },
    dark: { canvas: "#28201c", sidebar: "#211a18", primary: "#f27c37" },
  },
  {
    id: "iris",
    light: { canvas: "#f9f7fc", sidebar: "#f1eef8", primary: "#6d28d9" },
    dark: { canvas: "#22202a", sidebar: "#1c1a23", primary: "#a380fe" },
  },
  {
    id: "rose",
    light: { canvas: "#fcf7fa", sidebar: "#f6edf3", primary: "#be185d" },
    dark: { canvas: "#271e25", sidebar: "#21191f", primary: "#eb5ca4" },
  },
];

export function parsePalette(stored: string | null): ThemePalette {
  return stored !== null && (PALETTE_IDS as readonly string[]).includes(stored)
    ? (stored as ThemePalette)
    : "default";
}

export function resolveTheme(pref: ThemePreference, sys: ResolvedTheme): ResolvedTheme {
  return pref === "system" ? sys : pref;
}

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
