import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeScheme = "light" | "dark";

const STORAGE_KEY = "eevee-theme";

function readPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {}
  return "system";
}

function resolveScheme(pref: ThemePreference): ThemeScheme {
  if (pref === "light" || pref === "dark") return pref;
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyScheme(scheme: ThemeScheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.colorScheme = scheme;
  document.documentElement.dataset.theme = scheme;
}

type ThemeState = {
  readonly preference: ThemePreference;
  readonly scheme: ThemeScheme;
};

const initialPreference = readPreference();
let currentTheme: ThemeState = {
  preference: initialPreference,
  scheme: resolveScheme(initialPreference),
};
const listeners = new Set<(next: ThemeState) => void>();

function emitTheme(next: ThemeState): void {
  currentTheme = next;
  applyScheme(next.scheme);
  for (const listener of listeners) listener(next);
}

let mediaBound = false;
function ensureMediaListener(): void {
  if (mediaBound || typeof window === "undefined" || !window.matchMedia) return;
  mediaBound = true;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (currentTheme.preference !== "system") return;
    emitTheme({ preference: "system", scheme: resolveScheme("system") });
  });
}

export function useTheme() {
  const [state, setState] = useState<ThemeState>(() => currentTheme);

  useEffect(() => {
    ensureMediaListener();
    applyScheme(currentTheme.scheme);
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    emitTheme({ preference: next, scheme: resolveScheme(next) });
  }, []);

  const cycle = useCallback(() => {
    const order: readonly ThemePreference[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(currentTheme.preference) + 1) % order.length] ?? "system";
    setPreference(next);
  }, [setPreference]);

  return { preference: state.preference, scheme: state.scheme, setPreference, cycle };
}
