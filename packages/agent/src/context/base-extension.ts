import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import {
  type ContextDiscovery,
  type ContextFile,
  discoverContext,
  type PromptContextOptions,
  type SkillInfo,
} from "./discovery.ts";
import { renderRulesSection, renderToolsSection } from "./tool-meta.ts";

export const BASE_EXTENSION = "eevee.base";

export type BaseExtensionOptions = Omit<PromptContextOptions, "workspaces"> & {
  readonly workspaces?: readonly string[] | (() => readonly string[]);
};

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(text: string): string {
  return escapeXml(text).replace(/"/g, "&quot;");
}

function renderContextFiles(files: readonly ContextFile[]): string | undefined {
  const parts = files
    .map((file) => {
      const trimmed = file.content.trim();
      if (trimmed === "") return undefined;
      const attrs =
        file.workspace === undefined
          ? `path="${escapeXmlAttr(file.path)}"`
          : `path="${escapeXmlAttr(file.path)}" workspace="${escapeXmlAttr(file.workspace)}"`;
      return `<context-file ${attrs}>\n${trimmed}\n</context-file>`;
    })
    .filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function renderSkills(
  skills: readonly SkillInfo[],
  reader: "read" | "bash" | "powershell" | "codemode" | undefined,
): string | undefined {
  if (reader === undefined) return undefined;
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return undefined;
  const entries = visible
    .map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n    <location>${escapeXml(skill.path)}</location>\n  </skill>`,
    )
    .join("\n");
  const instruction =
    reader === "codemode"
      ? "Use codemode (tools.read) to load a skill's file when the task matches its description."
      : `Use ${reader} to load a skill's file when the task matches its description.`;
  return [
    "The following skills provide specialized instructions for specific tasks.",
    instruction,
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
    entries,
    "</available_skills>",
  ].join("\n");
}

function skillReader(
  agent: PromptInput["agent"],
): "read" | "bash" | "powershell" | "codemode" | undefined {
  const toolNames = agent.tools.map((tool) => tool.name);
  if (toolNames.includes("read")) return "read";
  if (toolNames.includes("bash")) return "bash";
  if (toolNames.includes("powershell")) return "powershell";
  if (toolNames.includes("codemode") && agent.callable.some((tool) => tool.name === "read")) {
    return "codemode";
  }
  return undefined;
}

export function createBaseExtension(options: BaseExtensionOptions = {}) {
  const discoveries = new WeakMap<object, Promise<ContextDiscovery>>();
  const discoverOnce = (input: PromptInput): Promise<ContextDiscovery> => {
    const key = input as object;
    const existing = discoveries.get(key);
    if (existing !== undefined) return existing;
    const configured =
      typeof options.workspaces === "function" ? options.workspaces() : options.workspaces;
    const workspaces =
      configured ?? (input.agent.cwd === undefined ? undefined : [input.agent.cwd]);
    const discovery = discoverContext({ globalDir: options.globalDir, workspaces });
    discoveries.set(key, discovery);
    return discovery;
  };

  return defineExtension({
    name: BASE_EXTENSION,
    sections: [
      section(
        "preamble",
        async () =>
          "You are an Eevee agent, a coding assistant built on pi-durable. Help the user inspect files, run commands, and modify code.",
        { tag: false },
      ),
      section("tools", (input) => renderToolsSection(input.agent.tools, input.agent.extensions)),
      section("rules", (input) =>
        renderRulesSection(input.agent.tools, undefined, input.agent.extensions),
      ),
      section("cwd", async (input) => input.agent.cwd?.replace(/\\/g, "/")),
      section("agent-context", async (input) => {
        const discovery = await discoverOnce(input);
        return renderContextFiles(discovery.contextFiles);
      }),
      section("skills", async (input) => {
        const discovery = await discoverOnce(input);
        const reader = skillReader(input.agent);
        return renderSkills(discovery.skills, reader);
      }),
    ],
  });
}
