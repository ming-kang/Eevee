import { en } from "./locales/en.ts";

/**
 * Interface languages. The source text is Chinese and is its own key: `t("新建项目")` reads as the
 * Chinese it shows, and the English table maps it. A missing entry falls back to the Chinese.
 */
export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_KEY = "eevee.locale";
export const LOCALE_NAME: Record<Locale, string> = { "zh-CN": "简体中文", en: "English" };

/** The stored choice, else the browser's language: Chinese for any `zh`, English otherwise. */
export function pickLocale(stored: string | null, browser: string | undefined): Locale {
  if (stored === "zh-CN" || stored === "en") return stored;
  return browser === undefined || browser.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

type Params = Record<string, string | number>;

/**
 * `text` with each `{name}` replaced by its parameter. A translation written `one|many` picks by `n`:
 * `"{n} file|{n} files"`.
 */
export function fill(text: string, params?: Params): string {
  if (params === undefined) return text;
  const forms = text.split("|");
  if (forms.length === 2 && typeof params.n === "number")
    text = forms[params.n === 1 ? 0 : 1] ?? text;
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
  : "zh-CN";
if (browser) browser.document.documentElement.lang = locale;

const table: Readonly<Record<string, string>> | undefined = locale === "en" ? en : undefined;

/**
 * The interface text for a Chinese source string, in the reader's language. A `::name` suffix tells
 * apart two meanings of one Chinese word (`"模型::list"` is "Models", `"模型"` is "Model") and never shows.
 */
export function t(key: string, params?: Params): string {
  return fill(table?.[key] ?? key.replace(/::\w+$/, ""), params);
}

export function setLocale(next: Locale): void {
  if (!browser || next === locale) return;
  browser.localStorage.setItem(LOCALE_KEY, next);
  browser.location.reload();
}
