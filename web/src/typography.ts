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
    dark: { canvas: "#09090b", sidebar: "#050507", primary: "#3b82f6" },
  },
  {
    id: "grove",
    light: { canvas: "#f5faf7", sidebar: "#ebf3ee", primary: "#15803d" },
    dark: { canvas: "#0c1410", sidebar: "#080e0b", primary: "#34d399" },
  },
  {
    id: "ocean",
    light: { canvas: "#f6f9fc", sidebar: "#edf3f8", primary: "#0369a1" },
    dark: { canvas: "#0a1118", sidebar: "#060b10", primary: "#38bdf8" },
  },
  {
    id: "ember",
    light: { canvas: "#fcf9f6", sidebar: "#f5efe9", primary: "#c2410c" },
    dark: { canvas: "#140e0b", sidebar: "#0d0907", primary: "#fb923c" },
  },
  {
    id: "iris",
    light: { canvas: "#f9f7fc", sidebar: "#f1eef8", primary: "#6d28d9" },
    dark: { canvas: "#100c18", sidebar: "#0a0710", primary: "#a78bfa" },
  },
  {
    id: "rose",
    light: { canvas: "#fcf7fa", sidebar: "#f6edf3", primary: "#be185d" },
    dark: { canvas: "#150c13", sidebar: "#0e070c", primary: "#f472b6" },
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
