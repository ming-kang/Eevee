import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fill } from "../../src/contracts/text.ts";
import { pickForm, pickLocale, t } from "./i18n.ts";
import { zhCN } from "./locales/zh-CN.ts";

test("pickLocale uses the stored choice, else the browser: zh means Chinese, otherwise English", () => {
  assert.equal(pickLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(pickLocale("en", "zh-CN"), "en");
  assert.equal(pickLocale(null, "zh-TW"), "zh-CN");
  assert.equal(pickLocale("fr", "en-GB"), "en");
  assert.equal(pickLocale(null, undefined), "en");
});

test("fill replaces {name} and leaves a missing parameter alone; under Node t returns the English source", () => {
  assert.equal(fill("{n} open", { n: 3 }), "3 open");
  assert.equal(fill("{a} and {b}", { a: 1 }), "1 and {b}");
  assert.equal(t("{n} open", { n: 2 }), "2 open");
  assert.equal(t("Models::list"), "Models");
});

test("a form written one|many is picked by n", () => {
  assert.equal(pickForm("{n} file|{n} files", { n: 1 }), "{n} file");
  assert.equal(pickForm("{n} file|{n} files", { n: 3 }), "{n} files");
  assert.equal(pickForm("a|b", { name: "x" }), "a|b");
  assert.equal(t("{n} file|{n} files", { n: 1 }), "1 file");
  assert.equal(t("{n} file|{n} files", { n: 3 }), "3 files");
});
const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CJK = /[　-〿一-鿿＀-￯]/;

/** Files outside web/src whose `t()` calls are interface text too. */
const CONTRACT_TEXT = [
  join(root, "../../src/contracts/problem.ts"),
  join(root, "../../src/contracts/failure.ts"),
];

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

/** The strings `t()` looks up: each plural form of a `one|many` key, the key itself otherwise. */
function lookups(key: string): string[] {
  const forms = key.split("|");
  return forms.length === 2 ? forms : [key];
}

test("every interface string goes through t(), each has Chinese, and the table has no extras", () => {
  const used = new Set<string>();
  const leftovers: string[] = [];
  for (const file of [...sources(root), ...CONTRACT_TEXT]) {
    const text = code(readFileSync(file, "utf8"));
    for (const match of text.matchAll(KEY)) {
      const key = (match[2] ?? "").replace(/\\(.)/g, "$1");
      for (const lookup of lookups(key)) used.add(lookup);
    }
    text
      .replace(KEY, "t(")
      .split("\n")
      .forEach((line, index) => {
        if (CJK.test(line)) leftovers.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(leftovers, [], "Chinese outside t()");
  assert.deepEqual(
    [...used].filter((key) => !(key in zhCN)),
    [],
    "Missing Chinese",
  );
  assert.deepEqual(
    Object.keys(zhCN).filter((key) => !used.has(key)),
    [],
    "Unused Chinese",
  );
});
