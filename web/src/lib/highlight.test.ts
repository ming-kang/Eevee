import assert from "node:assert/strict";
import test from "node:test";
import { resolveLang } from "./highlight.ts";

// Only the pure mapping is under test here: the Shiki half pulls in the DOM-free test tsconfig's
// nemeses (lazy grammars, browser-only bundles), so it stays untested and unreachable from tests.

test("aliases map fence spellings onto bundled grammars", () => {
  const cases: [string, string][] = [
    ["sh", "bash"],
    ["shell", "bash"],
    ["zsh", "bash"],
    ["bash", "bash"],
    ["powershell", "powershell"],
    ["ps1", "powershell"],
    ["js", "javascript"],
    ["mjs", "javascript"],
    ["ts", "typescript"],
    ["jsx", "jsx"],
    ["tsx", "tsx"],
    ["py", "python"],
    ["rs", "rust"],
    ["yml", "yaml"],
    ["tex", "latex"],
    ["md", "markdown"],
    ["c++", "cpp"],
    ["jsonc", "jsonc"],
  ];
  for (const [info, lang] of cases) assert.equal(resolveLang(info), lang, info);
});

test("allowlisted names resolve to themselves, case-insensitively", () => {
  for (const info of ["JSON", "TypeScript", "Vue", "Diff", "SQL", "HTML", "CSS", "XML"]) {
    assert.notEqual(resolveLang(info), undefined, info);
  }
});

test("unknown or empty info strings stay plain", () => {
  for (const info of [undefined, "", "   ", "brainfuck", "nginx", "text"]) {
    assert.ok(resolveLang(info) === undefined, String(info));
  }
});

test("only the first word of an info string counts", () => {
  assert.equal(resolveLang("ts title=main.ts"), "typescript");
  assert.equal(resolveLang("py linenums"), "python");
});
