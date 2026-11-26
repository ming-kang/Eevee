import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

export type ToolPromptMeta = {
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

const toolPromptMeta = new WeakMap<object, ToolPromptMeta>();

function normalizeSnippet(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function dedupeGuidelines(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): readonly string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [first, second]) {
    if (list === undefined) continue;
    for (const item of list) {
      const normalized = item.trim();
      if (normalized === "" || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out.length === 0 ? undefined : out;
}

function mergePromptMeta(
  base: ToolPromptMeta | undefined,
  override: ToolPromptMeta | undefined,
): ToolPromptMeta | undefined {
  if (base === undefined && override === undefined) return undefined;
  const promptSnippet =
    normalizeSnippet(override?.promptSnippet) ?? normalizeSnippet(base?.promptSnippet);
  const promptGuidelines = dedupeGuidelines(base?.promptGuidelines, override?.promptGuidelines);
  if (promptSnippet === undefined && promptGuidelines === undefined) return undefined;
  return {
    ...(promptSnippet === undefined ? {} : { promptSnippet }),
    ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
  };
}

export function getToolPromptMeta(tool: object): ToolPromptMeta | undefined {
  return toolPromptMeta.get(tool);
}

export function withToolPromptMeta<T extends object>(
  tool: T,
  meta: ToolPromptMeta,
  base?: object,
): T {
  const inherited =
    getToolPromptMeta(tool) ?? (base === undefined ? undefined : getToolPromptMeta(base));
  const merged = mergePromptMeta(inherited, meta);
  if (merged === undefined) {
    toolPromptMeta.delete(tool);
  } else {
    toolPromptMeta.set(tool, merged);
  }
  return tool;
}

export function resolveToolPromptMeta(
  tool: ToolRegistration,
  extensions?: readonly Extension[],
): ToolPromptMeta | undefined {
  const own = getToolPromptMeta(tool);
  if (extensions === undefined) return own;
  let original: ToolRegistration | undefined;
  for (const extension of extensions) {
    for (const candidate of extension.tools ?? []) {
      if (candidate.name === tool.name) original = candidate;
    }
  }
  if (original === undefined || original === tool) return own;
  return mergePromptMeta(getToolPromptMeta(original), own);
}

export function renderToolsSection(
  tools: readonly ToolRegistration[],
  extensions?: readonly Extension[],
): string | undefined {
  const lines: string[] = [];
  for (const tool of tools) {
    const snippet = resolveToolPromptMeta(tool, extensions)?.promptSnippet;
    if (snippet !== undefined) lines.push(`- ${tool.name}: ${snippet}`);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

export function renderRulesSection(
  tools: readonly ToolRegistration[],
  extraRules?: readonly string[],
  extensions?: readonly Extension[],
): string | undefined {
  const hasExtra = extraRules?.some((rule) => rule.trim() !== "") === true;
  if (tools.length === 0 && !hasExtra) return undefined;

  const rules: string[] = [];
  const seen = new Set<string>();
  const addRule = (rule: string) => {
    const normalized = rule.trim();
    if (normalized === "" || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };

  const offered = new Set(tools.map((tool) => tool.name));
  const hasBash = offered.has("bash");
  const hasPowerShell = offered.has("powershell");
  if (
    (hasBash || hasPowerShell) &&
    !offered.has("grep") &&
    !offered.has("find") &&
    !offered.has("ls")
  ) {
    if (hasBash && hasPowerShell) {
      addRule(
        "Use bash or PowerShell for file operations like listing, searching, and finding files",
      );
    } else if (hasPowerShell) {
      addRule("Use PowerShell for file operations like listing, searching, and finding files");
    } else {
      addRule("Use bash for file operations like ls, rg, find");
    }
  }

  for (const tool of tools) {
    for (const guideline of resolveToolPromptMeta(tool, extensions)?.promptGuidelines ?? []) {
      addRule(guideline);
    }
  }
  for (const rule of extraRules ?? []) addRule(rule);
  addRule("Be concise in your responses");
  addRule("Show file paths clearly when working with files");

  return rules.map((rule) => `- ${rule}`).join("\n");
}
