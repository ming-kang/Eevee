/**
 * Syntax highlighting on a lazy Shiki core: the JavaScript regex engine (no wasm), both GitHub
 * themes, and grammars pulled in one at a time as messages need them. With `defaultColor: false`
 * every span carries `--shiki-light`/`--shiki-dark`, so the palette follows our `[data-theme]`
 * instead of a baked-in one; our own code background and padding stay untouched.
 */
import type { HighlighterCore } from "shiki/core";

/** The languages the panel can colour; anything else renders plain. */
const LOADER: Record<string, () => Promise<unknown>> = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  latex: () => import("shiki/dist/langs/latex.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  powershell: () => import("shiki/dist/langs/powershell.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  vue: () => import("shiki/dist/langs/vue.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
};

/** Fence `info` spellings that point at a grammar in `LOADER`. */
const ALIAS: Record<string, string> = {
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  js: "javascript",
  json5: "jsonc",
  md: "markdown",
  mjs: "javascript",
  ps1: "powershell",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  tex: "latex",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
};

/**
 * The grammar a fenced block's info string asks for, or undefined when the panel can't colour it.
 * Only the first word counts (` ```ts title=x `).
 */
export function resolveLang(info: string | undefined): string | undefined {
  const word = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (word === "") return undefined;
  if (LOADER[word] !== undefined) return word;
  const alias = ALIAS[word];
  return alias !== undefined && LOADER[alias] !== undefined ? alias : undefined;
}

type Themes = { light: string; dark: string };

const THEMES: Themes = { light: "github-light", dark: "github-dark-default" };

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [shikiCore, engine, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/dist/themes/github-light.mjs"),
      import("shiki/dist/themes/github-dark-default.mjs"),
    ]);
    return shikiCore.createHighlighterCore({
      themes: [light, dark],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    });
  })();
  return core;
}

async function ensureLang(h: HighlighterCore, lang: string): Promise<void> {
  let pending = loaded.get(lang);
  if (pending === undefined) {
    pending = (async () => {
      const grammar = await LOADER[lang]?.();
      if (grammar !== undefined) await h.loadLanguage(grammar as never);
    })().catch(() => undefined);
    loaded.set(lang, pending);
  }
  await pending;
}

/**
 * The block as Shiki HTML, or undefined when it can't be coloured (the caller keeps its plain
 * `<pre>`). Never throws: a grammar problem or a failed lazy import just falls back to plain.
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | undefined> {
  try {
    const h = await highlighter();
    await ensureLang(h, lang);
    if (!h.getLoadedLanguages().includes(lang)) return undefined;
    return h.codeToHtml(code, { lang, themes: THEMES, defaultColor: false });
  } catch {
    return undefined;
  }
}
