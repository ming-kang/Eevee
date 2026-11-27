import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeScheme = "light" | "dark";

const STORAGE_KEY = "eevee-theme";

function readPreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {}
  return "system";
}

function resolveScheme(pref: ThemePreference): ThemeScheme {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyScheme(scheme: ThemeScheme): void {
  document.documentElement.dataset.colorScheme = scheme;
  document.documentElement.dataset.theme = scheme;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [scheme, setScheme] = useState<ThemeScheme>(() => resolveScheme(readPreference()));

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    const resolved = resolveScheme(next);
    setScheme(resolved);
    applyScheme(resolved);
  };

  useEffect(() => {
    const resolved = resolveScheme(preference);
    setScheme(resolved);
    applyScheme(resolved);
    if (preference !== "system" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const updated = resolveScheme("system");
      setScheme(updated);
      applyScheme(updated);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const cycle = () => {
    const order: readonly ThemePreference[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(preference) + 1) % order.length] ?? "system";
    setPreference(next);
  };

  return { preference, scheme, setPreference, cycle };
}
