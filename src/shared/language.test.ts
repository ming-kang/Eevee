import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * The one file where Chinese belongs: the panel's translation table. English is the source language
 * and its own key, so every other Chinese string in the source is a leftover.
 */
const TRANSLATIONS = "web/src/locales/zh-CN.ts";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : sources(path);
    return /\.(ts|mjs|vue)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * What is left of a file once comments and regex literals are dropped: a regex may legitimately match
 * the Engine's own words, and `LOCALE_NAME` maps a locale to what its own speakers call it. Both are
 * data, not prose. Everything else must be English.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/(^\s*|[=(,:?]\s*)\/(?:\\.|[^/\n\\])+\/[gimsuy]*/gm, "$1")
    .replace(/LOCALE_NAME[^=]*=\s*\{[^}]*\}/g, (m) => m.replace(/[^\n]/g, " "));
}

test("no Chinese in the source, comments and regexes aside", () => {
  const leftovers: string[] = [];
  for (const dir of ["src", "web/src", "scripts"]) {
    for (const file of sources(join(root, dir))) {
      if (relative(root, file).replace(/\\/g, "/") === TRANSLATIONS) continue;
      code(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, index) => {
          if (CJK.test(line))
            leftovers.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
        });
    }
  }
  assert.deepEqual(leftovers, [], "Chinese left in the source");
});
