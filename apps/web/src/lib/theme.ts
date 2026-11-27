import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeScheme = "light" | "dark";
export type ThemePreset = "paper" | "pi" | "graphite" | "lagoon";
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
        "oklch(97.7% 0.004 92)",
        "oklch(95.3% 0.005 86)",
        "oklch(99.6% 0.001 92)",
        "oklch(21.5% 0.008 72)",
        "oklch(47.5% 0.095 235)",
      ],
      dark: [
        "oklch(19.5% 0.005 70)",
        "oklch(16.8% 0.005 68)",
        "oklch(23.2% 0.006 72)",
        "oklch(92.5% 0.006 84)",
        "oklch(73% 0.09 230)",
      ],
    },
  },
  {
    id: "pi",
    tone: "cool",
    swatches: {
      light: [
        "oklch(97.85% 0 0)",
        "oklch(95.71% 0 0)",
        "oklch(99.8% 0 0)",
        "oklch(20.1% 0 0)",
        "oklch(44.62% 0.0663 231.49)",
      ],
      dark: [
        "oklch(19.8% 0.006 245)",
        "oklch(16.8% 0.006 245)",
        "oklch(23.5% 0.008 245)",
        "oklch(92.5% 0.004 245)",
        "oklch(74.2% 0.077 231.49)",
      ],
    },
  },
  {
    id: "graphite",
    tone: "neutral",
    swatches: {
      light: [
        "oklch(97.85% 0 0)",
        "oklch(95.71% 0 0)",
        "oklch(100% 0 0)",
        "oklch(17.76% 0 0)",
        "oklch(28.26% 0 0)",
      ],
      dark: [
        "oklch(18.5% 0 0)",
        "oklch(15.5% 0 0)",
        "oklch(22.2% 0 0)",
        "oklch(93% 0 0)",
        "oklch(84% 0 0)",
      ],
    },
  },
  {
    id: "lagoon",
    tone: "cool",
    swatches: {
      light: [
        "oklch(97.85% 0.0023 158.68)",
        "oklch(95.71% 0.0056 158.68)",
        "oklch(99.6% 0.001 160)",
        "oklch(21% 0.01 165)",
        "oklch(44.62% 0.075 158.68)",
      ],
      dark: [
        "oklch(19.6% 0.008 168)",
        "oklch(16.8% 0.008 168)",
        "oklch(23.4% 0.01 168)",
        "oklch(92.5% 0.006 165)",
        "oklch(74.2% 0.095 158.68)",
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
  if (raw === "paper" || raw === "pi" || raw === "graphite" || raw === "lagoon") return raw;
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
