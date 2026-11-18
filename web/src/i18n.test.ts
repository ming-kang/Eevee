import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fill, pickLocale, t } from "./i18n.ts";
import { en } from "./locales/en.ts";

test("pickLocale 先用保存的语言，否则看浏览器：zh 开头是中文，其余英文", () => {
  assert.equal(pickLocale("en", "zh-CN"), "en");
  assert.equal(pickLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(pickLocale(null, "zh-TW"), "zh-CN");
  assert.equal(pickLocale("fr", "en-GB"), "en");
  assert.equal(pickLocale(null, undefined), "zh-CN");
});

test("fill 替换 {名字}，缺的参数原样留下；Node 下 t 返回中文原文", () => {
  assert.equal(fill("{n} 张未结", { n: 3 }), "3 张未结");
  assert.equal(fill("{a} 和 {b}", { a: 1 }), "1 和 {b}");
  assert.equal(t("{n} 张未结", { n: 2 }), "2 张未结");
  assert.equal(t("模型::list"), "模型");
});

test("英文写成 单数|复数 时按 n 挑一个", () => {
  assert.equal(fill("{n} file|{n} files", { n: 1 }), "1 file");
  assert.equal(fill("{n} file|{n} files", { n: 3 }), "3 files");
  assert.equal(fill("a|b", { name: "x" }), "a|b");
});

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CJK = /[　-〿一-鿿＀-￯]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : sources(path);
    const isSource = /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts");
    return isSource && entry.name !== "i18n.ts" ? [path] : [];
  });
}

/** The interface text of a file: comments and regex literals (which match the engine's own words) removed. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/(^\s*|[=(,:?]\s*)\/(?:\\.|[^/\n\\])+\/[gimsuy]*/gm, "$1");
}

const KEY = /\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;

test("界面文字都经过 t()，每个都有英文，英文表里没有多余的", () => {
  const used = new Set<string>();
  const leftovers: string[] = [];
  for (const file of sources(root)) {
    const text = code(readFileSync(file, "utf8"));
    for (const match of text.matchAll(KEY)) used.add((match[2] ?? "").replace(/\\(.)/g, "$1"));
    text
      .replace(KEY, "t(")
      .split("\n")
      .forEach((line, index) => {
        if (CJK.test(line)) leftovers.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(leftovers, [], "没有经过 t() 的中文");
  assert.deepEqual(
    [...used].filter((key) => !(key in en)),
    [],
    "缺英文",
  );
  assert.deepEqual(
    Object.keys(en).filter((key) => !used.has(key)),
    [],
    "没人用的英文",
  );
});
