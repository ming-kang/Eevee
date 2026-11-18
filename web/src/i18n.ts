import { zhCN } from "./locales/zh-CN.ts";

/**
 * Interface languages. English is the source language and its own key: `t("New project")` reads as
 * the English it shows, and the Chinese table maps it. A missing entry falls back to the English.
 */
export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_KEY = "eevee.locale";
export const LOCALE_NAME: Record<Locale, string> = { en: "English", "zh-CN": "简体中文" };

/** The stored choice, else the browser's language: Chinese for any `zh`, English otherwise. */
export function pickLocale(stored: string | null, browser: string | undefined): Locale {
  if (stored === "zh-CN" || stored === "en") return stored;
  return browser?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

type Params = Record<string, string | number>;

/** `one|many` picks a form by `n`; without a numeric `n`, or without a `|`, the text is left alone. */
export function pickForm(text: string, params?: Params): string {
  if (params === undefined || typeof params.n !== "number") return text;
  const forms = text.split("|");
  return forms.length === 2 ? (forms[params.n === 1 ? 0 : 1] ?? text) : text;
}

/** `text` with each `{name}` replaced by its parameter; a parameter the text does not use is left alone. */
export function fill(text: string, params?: Params): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

type Browser = {
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: { language: string };
  document: { documentElement: { lang: string } };
  location: { reload(): void };
};
// Only a page has a document; under Node (the tests) the interface stays in its source language.
const browser = "document" in globalThis ? (globalThis as unknown as Browser) : undefined;

/** Fixed for the page's life: changing it reloads, so text built when a module loads is right too. */
export const locale: Locale = browser
  ? pickLocale(browser.localStorage.getItem(LOCALE_KEY), browser.navigator.language)
  : "en";
if (browser) browser.document.documentElement.lang = locale;

const table: Readonly<Record<string, string>> | undefined = locale === "zh-CN" ? zhCN : undefined;

/**
 * The interface text for an English source string, in the reader's language. A `::name` suffix tells
 * apart two strings that read the same in English but not in Chinese (`"Interrupted::job"` is
 * "Interrupted", `"Interrupted"` is "已打断") and never shows.
 */
export function t(key: string, params?: Params): string {
  const chosen = pickForm(key, params);
  return fill(table?.[chosen] ?? chosen.replace(/::\w+$/, ""), params);
}

export function setLocale(next: Locale): void {
  if (!browser || next === locale) return;
  browser.localStorage.setItem(LOCALE_KEY, next);
  browser.location.reload();
}
