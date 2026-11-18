import type { AgentChange, Extension, RegistrySnapshot } from "@earendil-works/pi-durable";
import { agentModel, type ModelChoice, type RoleName } from "../contracts/index.ts";

export type MemorySnapshot = {
  global: string;
  project: string;
};

/**
 * A kind of conversation: its fixed prompt, its opening, and the extensions it always selects, by name.
 * Extensions are resolved against the registry whenever the role is applied, so a role holds no instances.
 */
export type Role<Subject> = {
  name: RoleName;
  instructions: string;
  extensions: readonly string[];
  opening(subject: Subject, memory: MemorySnapshot): string;
};

export const defineRole = <Subject>(role: Role<Subject>): Role<Subject> => role;

/** Durable's own extensions, added when the selected tools need them. */
const TOOL_SEARCH_EXTENSION = "tool-search";
const CODEMODE_EXTENSION = "codemode";

export type Capability = {
  extensions: Extension[];
  /** Names nothing installed answers to, such as an MCP server that is no longer configured. */
  missing: string[];
};

/**
 * Resolves extension names in order, without repeats. Deferred tools bring `tool-search` along, and tools
 * only scripts may call bring `codemode`, when those are installed.
 */
export function resolveCapability(
  registry: RegistrySnapshot,
  names: readonly string[],
): Capability {
  const extensions: Extension[] = [];
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const extension = registry.extension(name);
    if (extension === undefined) missing.push(name);
    else extensions.push(extension);
  }
  const tools = extensions.flatMap((e) => e.tools ?? []);
  const bring = (name: string, needed: boolean) => {
    if (!needed || extensions.some((e) => e.name === name)) return;
    const extension = registry.extension(name);
    if (extension !== undefined) extensions.push(extension);
  };
  bring(
    TOOL_SEARCH_EXTENSION,
    tools.some((t) => t.deferred === true),
  );
  bring(
    CODEMODE_EXTENSION,
    tools.some((t) => t.callers !== undefined && !t.callers.includes("model")),
  );
  return { extensions, missing };
}

/**
 * The agent change that applies a role: exactly its extensions, every tool they bring, its instructions.
 * `modelTools` stays as it is, so tools `tool_search` loaded keep being offered.
 */
export function roleChange(
  role: Role<never>,
  capability: Capability,
  options: { cwd: string; model?: ModelChoice; maxTurns?: number },
): AgentChange {
  return {
    extensions: capability.extensions,
    tools: null,
    instructions: role.instructions,
    cwd: options.cwd,
    maxTurns: options.maxTurns ?? null,
    ...(options.model === undefined ? {} : agentModel(options.model)),
  };
}
