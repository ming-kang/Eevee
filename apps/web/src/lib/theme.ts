import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeScheme = "light" | "dark";
export type ThemePreset = "paper" | "slate" | "graphite" | "lagoon";
export type ThemeTone = "warm" | "cool" | "neutral";

export type ThemePresetMeta = {
  readonly id: ThemePreset;
  readonly tone: ThemeTone;
  readonly swatches: {
    readonly light: readonly [string, string, string, string, string];
    readonly dark: readonly [string, string, string, string, string];
  };
};

export const THEME_PRESETS: readonly ThemePresetMeta[] = [
  {
    id: "paper",
    tone: "warm",
    swatches: {
      light: [
        "oklch(97.4% 0.005 88)",
        "oklch(94.9% 0.006 84)",
        "oklch(99.4% 0.002 90)",
        "oklch(21.5% 0.008 72)",
        "oklch(53.5% 0.115 44)",
      ],
      dark: [
        "oklch(26.8% 0.007 72)",
        "oklch(23.5% 0.006 70)",
        "oklch(30.8% 0.008 74)",
        "oklch(91% 0.007 84)",
        "oklch(74.5% 0.105 52)",
      ],
    },
  },
  {
    id: "slate",
    tone: "cool",
    swatches: {
      light: [
        "oklch(95.6% 0.012 245)",
        "oklch(92.4% 0.016 245)",
        "oklch(98.6% 0.005 245)",
        "oklch(22% 0.016 250)",
        "oklch(49% 0.125 248)",
      ],
      dark: [
        "oklch(26.8% 0.022 250)",
        "oklch(23.2% 0.02 250)",
        "oklch(31.2% 0.024 250)",
        "oklch(91.5% 0.01 245)",
        "oklch(74.5% 0.115 242)",
      ],
    },
  },
  {
    id: "graphite",
    tone: "neutral",
    swatches: {
      light: [
        "oklch(97.2% 0 0)",
        "oklch(94.2% 0 0)",
        "oklch(100% 0 0)",
        "oklch(18% 0 0)",
        "oklch(22% 0 0)",
      ],
      dark: [
        "oklch(26.5% 0 0)",
        "oklch(23% 0 0)",
        "oklch(30.8% 0 0)",
        "oklch(92% 0 0)",
        "oklch(87% 0 0)",
      ],
    },
  },
  {
    id: "lagoon",
    tone: "cool",
    swatches: {
      light: [
        "oklch(95.6% 0.013 155)",
        "oklch(92.4% 0.018 155)",
        "oklch(98.5% 0.006 155)",
        "oklch(22% 0.016 162)",
        "oklch(48% 0.105 160)",
      ],
      dark: [
        "oklch(26.8% 0.022 166)",
        "oklch(23.2% 0.02 166)",
        "oklch(31.2% 0.024 166)",
        "oklch(91.2% 0.012 162)",
        "oklch(75.5% 0.115 160)",
      ],
    },
  },
];

export const THEME_STORAGE_KEY = "eevee-theme";
export const THEME_PRESET_STORAGE_KEY = "eevee-theme-preset";
export const DEFAULT_THEME_PRESET: ThemePreset = "paper";

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function parseThemePreset(raw: string | null | undefined): ThemePreset {
  if (raw === "paper" || raw === "slate" || raw === "graphite" || raw === "lagoon") return raw;
  return DEFAULT_THEME_PRESET;
}

export function readStoredTheme(storage?: Pick<Storage, "getItem">): {
  readonly preference: ThemePreference;
  readonly preset: ThemePreset;
} {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  try {
    return {
      preference: parseThemePreference(store?.getItem(THEME_STORAGE_KEY)),
      preset: parseThemePreset(store?.getItem(THEME_PRESET_STORAGE_KEY)),
    };
  } catch {
    return { preference: "system", preset: DEFAULT_THEME_PRESET };
  }
}

function resolveScheme(pref: ThemePreference): ThemeScheme {
  if (pref === "light" || pref === "dark") return pref;
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemeAttributes(scheme: ThemeScheme, preset: ThemePreset): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.colorScheme = scheme;
  document.documentElement.dataset.theme = scheme;
  document.documentElement.dataset.themePreset = preset;
}

type ThemeState = {
  readonly preference: ThemePreference;
  readonly scheme: ThemeScheme;
  readonly preset: ThemePreset;
};

const initialStored = readStoredTheme();
let currentTheme: ThemeState = {
  preference: initialStored.preference,
  scheme: resolveScheme(initialStored.preference),
  preset: initialStored.preset,
};
const listeners = new Set<(next: ThemeState) => void>();

function emitTheme(next: ThemeState): void {
  currentTheme = next;
  applyThemeAttributes(next.scheme, next.preset);
  for (const listener of listeners) listener(next);
}

let mediaBound = false;
function ensureMediaListener(): void {
  if (mediaBound || typeof window === "undefined" || !window.matchMedia) return;
  mediaBound = true;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (currentTheme.preference !== "system") return;
    emitTheme({
      ...currentTheme,
      preference: "system",
      scheme: resolveScheme("system"),
    });
  });
}

export function useTheme() {
  const [state, setState] = useState<ThemeState>(() => currentTheme);

  useEffect(() => {
    ensureMediaListener();
    applyThemeAttributes(currentTheme.scheme, currentTheme.preset);
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {}
    emitTheme({
      ...currentTheme,
      preference: next,
      scheme: resolveScheme(next),
    });
  }, []);

  const setPreset = useCallback((next: ThemePreset) => {
    try {
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, next);
    } catch {}
    emitTheme({
      ...currentTheme,
      preset: next,
    });
  }, []);

  const cycle = useCallback(() => {
    const order: readonly ThemePreference[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(currentTheme.preference) + 1) % order.length] ?? "system";
    setPreference(next);
  }, [setPreference]);

  return {
    preference: state.preference,
    scheme: state.scheme,
    preset: state.preset,
    setPreference,
    setPreset,
    cycle,
  };
}
