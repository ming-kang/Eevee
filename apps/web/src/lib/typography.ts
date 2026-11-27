import { useCallback, useEffect, useState } from "react";

export type SizeBounds = {
  readonly min: number;
  readonly max: number;
  readonly default: number;
};

export type ChatWidth = "standard" | "wide";
export type ProseFont = "wenkai" | "sans" | "mono";

export const UI_SIZE_BOUNDS = { min: 12, max: 22, default: 17 } as const satisfies SizeBounds;
export const CODE_SIZE_BOUNDS = { min: 10, max: 22, default: 15 } as const satisfies SizeBounds;
export const DEFAULT_CHAT_WIDTH: ChatWidth = "standard";
export const DEFAULT_PROSE_FONT: ProseFont = "wenkai";

export const UI_SIZE_STORAGE_KEY = "eevee-ui-size";
export const CODE_SIZE_STORAGE_KEY = "eevee-code-size";
export const CHAT_WIDTH_STORAGE_KEY = "eevee-chat-width";
export const PROSE_FONT_STORAGE_KEY = "eevee-prose-font";

export type TypographySettings = {
  readonly uiSize: number;
  readonly codeSize: number;
  readonly chatWidth: ChatWidth;
  readonly proseFont: ProseFont;
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

export function parseChatWidth(raw: string | null | undefined): ChatWidth {
  return raw === "wide" ? "wide" : DEFAULT_CHAT_WIDTH;
}

export function parseProseFont(raw: string | null | undefined): ProseFont {
  if (raw === "sans" || raw === "mono" || raw === "wenkai") return raw;
  return DEFAULT_PROSE_FONT;
}

export function readTypographySettings(storage?: Pick<Storage, "getItem">): TypographySettings {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  try {
    return {
      uiSize: parseBoundedSize(store?.getItem(UI_SIZE_STORAGE_KEY), UI_SIZE_BOUNDS),
      codeSize: parseBoundedSize(store?.getItem(CODE_SIZE_STORAGE_KEY), CODE_SIZE_BOUNDS),
      chatWidth: parseChatWidth(store?.getItem(CHAT_WIDTH_STORAGE_KEY)),
      proseFont: parseProseFont(store?.getItem(PROSE_FONT_STORAGE_KEY)),
    };
  } catch {
    return {
      uiSize: UI_SIZE_BOUNDS.default,
      codeSize: CODE_SIZE_BOUNDS.default,
      chatWidth: DEFAULT_CHAT_WIDTH,
      proseFont: DEFAULT_PROSE_FONT,
    };
  }
}

export function applyTypography(settings: TypographySettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--ev-ui-size", `${settings.uiSize}px`);
  root.style.setProperty("--ev-code-size", `${settings.codeSize}px`);
  root.dataset.chatWidth = settings.chatWidth;
  root.dataset.proseFont = settings.proseFont;
}

let currentTypography: TypographySettings = readTypographySettings();
const listeners = new Set<(next: TypographySettings) => void>();

function updateTypography(next: TypographySettings): void {
  currentTypography = next;
  applyTypography(next);
  try {
    window.localStorage.setItem(UI_SIZE_STORAGE_KEY, String(next.uiSize));
    window.localStorage.setItem(CODE_SIZE_STORAGE_KEY, String(next.codeSize));
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, next.chatWidth);
    window.localStorage.setItem(PROSE_FONT_STORAGE_KEY, next.proseFont);
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

  const setChatWidth = useCallback((chatWidth: ChatWidth) => {
    if (chatWidth === currentTypography.chatWidth) return;
    updateTypography({ ...currentTypography, chatWidth });
  }, []);

  const setProseFont = useCallback((proseFont: ProseFont) => {
    if (proseFont === currentTypography.proseFont) return;
    updateTypography({ ...currentTypography, proseFont });
  }, []);

  const reset = useCallback(() => {
    updateTypography({
      uiSize: UI_SIZE_BOUNDS.default,
      codeSize: CODE_SIZE_BOUNDS.default,
      chatWidth: DEFAULT_CHAT_WIDTH,
      proseFont: DEFAULT_PROSE_FONT,
    });
  }, []);

  return {
    uiSize: settings.uiSize,
    codeSize: settings.codeSize,
    chatWidth: settings.chatWidth,
    proseFont: settings.proseFont,
    setUiSize,
    setCodeSize,
    setChatWidth,
    setProseFont,
    reset,
  };
}
