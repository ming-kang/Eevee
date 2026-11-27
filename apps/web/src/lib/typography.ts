import { useCallback, useEffect, useState } from "react";

export type SizeBounds = {
  readonly min: number;
  readonly max: number;
  readonly default: number;
};

export const UI_SIZE_BOUNDS = { min: 12, max: 20, default: 16 } as const satisfies SizeBounds;
export const CODE_SIZE_BOUNDS = { min: 10, max: 18, default: 13 } as const satisfies SizeBounds;

export const UI_SIZE_STORAGE_KEY = "eevee-ui-size";
export const CODE_SIZE_STORAGE_KEY = "eevee-code-size";

export type TypographySettings = {
  readonly uiSize: number;
  readonly codeSize: number;
};

export function parseBoundedSize(raw: string | null | undefined, bounds: SizeBounds): number {
  if (raw === null || raw === undefined) return bounds.default;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return bounds.default;
  const value = Number(trimmed);
  if (value < bounds.min || value > bounds.max) return bounds.default;
  return value;
}

export function clampSize(value: number, bounds: SizeBounds): number {
  if (!Number.isFinite(value)) return bounds.default;
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

export function readTypographySettings(storage?: Pick<Storage, "getItem">): TypographySettings {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  try {
    return {
      uiSize: parseBoundedSize(store?.getItem(UI_SIZE_STORAGE_KEY), UI_SIZE_BOUNDS),
      codeSize: parseBoundedSize(store?.getItem(CODE_SIZE_STORAGE_KEY), CODE_SIZE_BOUNDS),
    };
  } catch {
    return { uiSize: UI_SIZE_BOUNDS.default, codeSize: CODE_SIZE_BOUNDS.default };
  }
}

export function applyTypography(settings: TypographySettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--ev-ui-size", `${settings.uiSize}px`);
  root.style.setProperty("--ev-code-size", `${settings.codeSize}px`);
}

let currentTypography: TypographySettings = readTypographySettings();
const listeners = new Set<(next: TypographySettings) => void>();

function updateTypography(next: TypographySettings): void {
  currentTypography = next;
  applyTypography(next);
  try {
    window.localStorage.setItem(UI_SIZE_STORAGE_KEY, String(next.uiSize));
    window.localStorage.setItem(CODE_SIZE_STORAGE_KEY, String(next.codeSize));
  } catch {}
  for (const listener of listeners) listener(next);
}

export function useTypography() {
  const [settings, setSettings] = useState<TypographySettings>(() => currentTypography);

  useEffect(() => {
    applyTypography(currentTypography);
    listeners.add(setSettings);
    return () => {
      listeners.delete(setSettings);
    };
  }, []);

  const setUiSize = useCallback((size: number) => {
    const uiSize = clampSize(size, UI_SIZE_BOUNDS);
    if (uiSize === currentTypography.uiSize) return;
    updateTypography({ ...currentTypography, uiSize });
  }, []);

  const setCodeSize = useCallback((size: number) => {
    const codeSize = clampSize(size, CODE_SIZE_BOUNDS);
    if (codeSize === currentTypography.codeSize) return;
    updateTypography({ ...currentTypography, codeSize });
  }, []);

  const reset = useCallback(() => {
    updateTypography({ uiSize: UI_SIZE_BOUNDS.default, codeSize: CODE_SIZE_BOUNDS.default });
  }, []);

  return {
    uiSize: settings.uiSize,
    codeSize: settings.codeSize,
    setUiSize,
    setCodeSize,
    reset,
  };
}
