import { useCallback, useEffect, useState } from "react";
import { EN } from "./locales/en.ts";
import { type LocaleKey, ZH_CN } from "./locales/zh-CN.ts";

export type Locale = "zh-CN" | "en";
export type { LocaleKey };

export const LOCALE_STORAGE_KEY = "eevee-locale";

const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<LocaleKey, string>>>> = {
  "zh-CN": ZH_CN,
  en: EN,
};

export function parseLocale(raw: string | null | undefined): Locale | undefined {
  if (raw === "zh-CN" || raw === "en") return raw;
  return undefined;
}

export function detectDefaultLocale(language?: string): Locale {
  const lang = (
    language ??
    (typeof navigator !== "undefined" ? navigator.language : undefined) ??
    "zh-CN"
  ).toLowerCase();
  return lang.startsWith("zh") ? "zh-CN" : "en";
}

export function readInitialLocale(
  storage?: Pick<Storage, "getItem">,
  navigatorLanguage?: string,
): Locale {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  try {
    const saved = parseLocale(store?.getItem(LOCALE_STORAGE_KEY));
    if (saved !== undefined) return saved;
  } catch {}
  if (navigatorLanguage === undefined && typeof window === "undefined") {
    return "zh-CN";
  }
  return detectDefaultLocale(navigatorLanguage);
}

export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

export function translateFor(
  locale: Locale,
  key: LocaleKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const template = DICTIONARIES[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

let currentLocale: Locale = readInitialLocale();
const listeners = new Set<(next: Locale) => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setGlobalLocale(next: Locale): void {
  if (next === currentLocale) return;
  currentLocale = next;
  applyDocumentLocale(next);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {}
  for (const listener of listeners) listener(next);
}

export function t(key: LocaleKey, params?: Readonly<Record<string, string | number>>): string {
  return translateFor(currentLocale, key, params);
}

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(() => currentLocale);

  useEffect(() => {
    applyDocumentLocale(currentLocale);
    listeners.add(setLocaleState);
    return () => {
      listeners.delete(setLocaleState);
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setGlobalLocale(next);
  }, []);

  const translate = useCallback(
    (key: LocaleKey, params?: Readonly<Record<string, string | number>>) =>
      translateFor(locale, key, params),
    [locale],
  );

  return { locale, setLocale, t: translate };
}
