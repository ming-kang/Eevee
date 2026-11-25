import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentChange,
  CompactionSettings,
  Extension,
  RegistrySnapshot,
} from "@earendil-works/pi-durable";
import {
  AGENT_EXTENSIONS,
  BASE_EXTENSION,
  MCP_SERVER_EXTENSION_PREFIX,
  type ModelChoice,
} from "@eevee/agent";
import { MEMORY_EXTENSION } from "@eevee/memory";

export const ROUTER_EXTENSION = "eevee.router";
export const WORKER_EXTENSION = "eevee.worker";

export const ROUTER_EXTENSIONS = [
  AGENT_EXTENSIONS.readonlyTools,
  AGENT_EXTENSIONS.shellPaths,
  AGENT_EXTENSIONS.codemode,
  AGENT_EXTENSIONS.toolSearch,
  AGENT_EXTENSIONS.mcp,
  MEMORY_EXTENSION,
  ROUTER_EXTENSION,
] as const;

export const WORKER_EXTENSIONS = [
  AGENT_EXTENSIONS.codingTools,
  AGENT_EXTENSIONS.shellPaths,
  AGENT_EXTENSIONS.tasks,
  AGENT_EXTENSIONS.codemode,
  AGENT_EXTENSIONS.toolSearch,
  AGENT_EXTENSIONS.mcp,
  AGENT_EXTENSIONS.cachedCompaction,
  WORKER_EXTENSION,
] as const;

export const ROUTER_COLLAB_TOOLS = [
  "spawn_worker",
  "message_worker",
  "close_ticket",
  "stop_worker",
  "inspect_worker",
  "ask_user",
] as const;

export const WORKER_COLLAB_TOOLS = ["message_router"] as const;

export type ModelSlot = "router" | "worker" | "dreamer";
export type ModelSlots = Partial<Record<ModelSlot, ModelChoice>>;
export type WorkerRole = "router" | "worker";

export type RoleAgentOptions = {
  readonly snapshot: RegistrySnapshot;
  readonly model?: ModelChoice;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly instructions?: string;
  readonly cwd?: string;
  readonly compaction?: CompactionSettings;
};

export const DEFAULT_ROUTER_INSTRUCTIONS = `You are the Eevee Router, the user's primary conversation. Delegate substantial implementation, investigation, and multi-step work to Workers with spawn_worker instead of doing it yourself. Use message_worker to reply, steer, or assign a new ticket to an existing Worker, close_ticket to close finished work, stop_worker to interrupt or close a Worker, inspect_worker to check status/transcripts/tasks, and ask_user to ask the user non-blocking structured questions. When a Worker or user-answer notice arrives as an eevee.notice, use its result and continue the user's work.`;

export const DEFAULT_WORKER_INSTRUCTIONS = `You are an Eevee Worker, a reusable background conversation owned by the Router. Work autonomously in your configured workspace and use your coding tools to complete the ticket. Use message_router to send progress updates, ask the Router for missing information, or report conclusions immediately. When your run ends with no active background tasks and the last tool round did not call message_router, your final reply is automatically handed off to the Router, so make it a concise report of what changed, what was verified, and anything still blocked.`;

export function parseModelSpec(spec: string, models: Models): ModelChoice | undefined {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) return undefined;
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  if (models.getModel(provider, modelId) === undefined) return undefined;
  return { provider, modelId };
}

export function resolveRoleExtensions(role: WorkerRole, snapshot: RegistrySnapshot): Extension[] {
  const selected: Extension[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (seen.has(name)) return;
    const extension = snapshot.extension(name);
    if (extension === undefined) return;
    seen.add(name);
    selected.push(extension);
  };

  add(BASE_EXTENSION);
  for (const name of role === "router" ? ROUTER_EXTENSIONS : WORKER_EXTENSIONS) add(name);
  if (snapshot.extension(AGENT_EXTENSIONS.mcp) !== undefined) {
    for (const extension of snapshot.installed()) {
      if (extension.name.startsWith(MCP_SERVER_EXTENSION_PREFIX)) add(extension.name);
    }
  }
  return selected;
}

export function buildRouterAgent(options: RoleAgentOptions): AgentChange {
  return buildRoleAgent("router", options);
}

export function buildWorkerAgent(options: RoleAgentOptions): AgentChange {
  return buildRoleAgent("worker", options);
}

function buildRoleAgent(role: WorkerRole, options: RoleAgentOptions): AgentChange {
  const thinkingLevel = options.thinkingLevel ?? options.model?.thinkingLevel;
  return {
    extensions: resolveRoleExtensions(role, options.snapshot),
    ...(options.model === undefined
      ? {}
      : { model: { provider: options.model.provider, modelId: options.model.modelId } }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
  };
}
