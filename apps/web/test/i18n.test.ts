import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDefaultLocale, readInitialLocale, translateFor } from "../src/lib/i18n.ts";
import { EN } from "../src/lib/locales/en.ts";
import { type LocaleKey, ZH_CN } from "../src/lib/locales/zh-CN.ts";

test("zh-CN and en dictionaries contain identical key sets and matching interpolation params", () => {
  const zhKeys = Object.keys(ZH_CN).sort();
  const enKeys = Object.keys(EN).sort();
  assert.deepEqual(enKeys, zhKeys);

  const placeholders = (text: string) =>
    [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ""))].sort();

  for (const key of zhKeys as LocaleKey[]) {
    assert.deepEqual(
      placeholders(EN[key]),
      placeholders(ZH_CN[key]),
      `Placeholder mismatch for locale key "${key}"`,
    );
  }
});

test("translateFor interpolates parameters and readInitialLocale respects saved preference", () => {
  assert.equal(translateFor("zh-CN", "chat.queued", { count: 3 }), "队列中（3）");
  assert.equal(translateFor("en", "chat.queued", { count: 3 }), "Queued (3)");

  assert.equal(detectDefaultLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(detectDefaultLocale("en-US"), "en");

  const stored = new Map<string, string>([["eevee-locale", "en"]]);
  assert.equal(readInitialLocale({ getItem: (k) => stored.get(k) ?? null }, "zh-CN"), "en");
});
