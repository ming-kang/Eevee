import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpHub } from "@eevee/agent";
import { parseMcpConfig } from "@eevee/agent";
import {
  composeProviders,
  type ModelRuntime,
  ModelsConfigError,
  parseModelsConfig,
} from "@eevee/agent/models";
import type { ModelSlots } from "@eevee/core";
import {
  type ConfigBundle,
  ConfigBundleSchema,
  type EngineSettings,
  EngineSettingsSchema,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  parseWithSchema,
  type ToolsSettings,
} from "@eevee/protocol";
import type { DataDirLayout } from "./data-dir.ts";
import { EngineError } from "./engine-error.ts";
import type { EngineStore } from "./store.ts";

export const KV_SETTINGS = "settings";
export const KV_MODEL_PROFILES = "model_profiles";
export const KV_MCP_SERVERS = "mcp_servers";

export const DEFAULT_MAX_ACTIVE_WORKERS = 3;
export const DEFAULT_BACKGROUND_AFTER_MS = 30_000;
export const DEFAULT_ROUTER_CONTEXT_TOKENS = 80_000;
export const DEFAULT_IDLE_HIBERNATE_MS = 10 * 60_000;
export const MAX_HIBERNATE_SWEEP_MS = 30_000;
export const MIN_HIBERNATE_SWEEP_MS = 25;

export type EngineDefaults = {
  readonly defaultModelSlots?: ModelSlots;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number;
  readonly routerContextTokens?: number;
  readonly idleHibernateMs?: number;
};

export function formatModelProfiles(doc: ModelProfilesDocument): string | undefined {
  const notes = doc.notes?.trim();
  if (doc.profiles.length === 0 && !notes) return undefined;
  const lines: string[] = [];
  if (doc.profiles.length > 0) {
    lines.push(
      "Configured model profiles (pass `provider/modelId` and optional `thinkingLevel` to `spawn_worker` or `message_worker`):",
    );
    for (const profile of doc.profiles) {
      const thinking =
        profile.model.thinkingLevel === undefined
          ? ""
          : ` (thinking: ${profile.model.thinkingLevel})`;
      lines.push(
        `- ${profile.id}: ${profile.model.provider}/${profile.model.modelId}${thinking} — ${profile.description}`,
      );
    }
  }
  if (notes) {
    if (lines.length > 0) lines.push("");
    lines.push(notes);
  }
  return lines.join("\n");
}

export function readEngineSettings(store: EngineStore): EngineSettings {
  const stored = store.getKv<unknown>(KV_SETTINGS);
  if (stored === undefined) return {};
  return parseWithSchema(EngineSettingsSchema, stored, "stored settings");
}

export function effectiveEngineSettings(store: EngineStore): EngineSettings {
  const stored = store.getKv<unknown>(KV_SETTINGS);
  if (stored === undefined) return {};
  try {
    return parseWithSchema(EngineSettingsSchema, stored, "stored settings");
  } catch {
    return {};
  }
}

export function readModelProfiles(store: EngineStore): ModelProfilesDocument {
  const stored = store.getKv<unknown>(KV_MODEL_PROFILES);
  if (stored === undefined) return { profiles: [] };
  return parseWithSchema(ModelProfilesDocumentSchema, stored, "stored model_profiles");
}

export function getMcpServersRecord(store: EngineStore): Record<string, Record<string, unknown>> {
  return store.getKv<Record<string, Record<string, unknown>>>(KV_MCP_SERVERS) ?? {};
}

export function mergeToolsSettings(
  base: ToolsSettings | undefined,
  patch: ToolsSettings | undefined,
): ToolsSettings | undefined {
  if (base === undefined && patch === undefined) return undefined;
  const router =
    base?.router === undefined && patch?.router === undefined
      ? undefined
      : { ...base?.router, ...patch?.router };
  const worker =
    base?.worker === undefined && patch?.worker === undefined
      ? undefined
      : { ...base?.worker, ...patch?.worker };
  const codemode =
    base?.codemode === undefined && patch?.codemode === undefined
      ? undefined
      : { ...base?.codemode, ...patch?.codemode };
  return {
    ...(router === undefined ? {} : { router }),
    ...(worker === undefined ? {} : { worker }),
    ...(codemode === undefined ? {} : { codemode }),
  };
}

export function mergeEngineSettings(
  current: EngineSettings,
  validated: EngineSettings,
): EngineSettings {
  const mergedModels =
    validated.models === undefined
      ? current.models
      : {
          ...current.models,
          ...validated.models,
        };
  const mergedTools =
    validated.tools === undefined
      ? current.tools
      : mergeToolsSettings(current.tools, validated.tools);
  return {
    ...(validated.maxActiveWorkers !== undefined
      ? { maxActiveWorkers: validated.maxActiveWorkers }
      : current.maxActiveWorkers !== undefined
        ? { maxActiveWorkers: current.maxActiveWorkers }
        : {}),
    ...(validated.backgroundAfterMs !== undefined
      ? { backgroundAfterMs: validated.backgroundAfterMs }
      : current.backgroundAfterMs !== undefined
        ? { backgroundAfterMs: current.backgroundAfterMs }
        : {}),
    ...(validated.routerContextTokens !== undefined
      ? { routerContextTokens: validated.routerContextTokens }
      : current.routerContextTokens !== undefined
        ? { routerContextTokens: current.routerContextTokens }
        : {}),
    ...(validated.idleHibernateMs !== undefined
      ? { idleHibernateMs: validated.idleHibernateMs }
      : current.idleHibernateMs !== undefined
        ? { idleHibernateMs: current.idleHibernateMs }
        : {}),
    ...(mergedModels !== undefined ? { models: mergedModels } : {}),
    ...(mergedTools !== undefined ? { tools: mergedTools } : {}),
  };
}

export function normalizeMcpMap(
  servers: readonly { readonly name: string; readonly config: object }[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    servers.map((entry) => [entry.name, { ...entry.config } as Record<string, unknown>]),
  );
}

export type EngineKnobs = {
  readonly modelSlots: (projectId: string) => ModelSlots;
  readonly maxActiveWorkers: () => number;
  readonly backgroundAfterMs: () => number;
  readonly routerContextTokens: () => number;
  readonly idleHibernateMs: () => number;
  readonly toolPolicy: (projectId: string) => ToolsSettings | undefined;
};

export function engineKnobs(store: EngineStore, defaults: EngineDefaults): EngineKnobs {
  return {
    toolPolicy: (projectId) =>
      mergeToolsSettings(effectiveEngineSettings(store).tools, store.getProject(projectId)?.tools),
    modelSlots: (projectId) => {
      const project = store.getProject(projectId);
      const settingsModels = effectiveEngineSettings(store).models;
      const slots = defaults.defaultModelSlots;
      const router = project?.models?.router ?? settingsModels?.router ?? slots?.router;
      const worker = project?.models?.worker ?? settingsModels?.worker ?? slots?.worker;
      const dreamer = project?.models?.dreamer ?? settingsModels?.dreamer ?? slots?.dreamer;
      return {
        ...(router === undefined ? {} : { router }),
        ...(worker === undefined ? {} : { worker }),
        ...(dreamer === undefined ? {} : { dreamer }),
      };
    },
    maxActiveWorkers: () =>
      effectiveEngineSettings(store).maxActiveWorkers ??
      defaults.maxActiveWorkers ??
      DEFAULT_MAX_ACTIVE_WORKERS,
    backgroundAfterMs: () =>
      effectiveEngineSettings(store).backgroundAfterMs ??
      defaults.backgroundAfterMs ??
      DEFAULT_BACKGROUND_AFTER_MS,
    routerContextTokens: () =>
      effectiveEngineSettings(store).routerContextTokens ??
      defaults.routerContextTokens ??
      DEFAULT_ROUTER_CONTEXT_TOKENS,
    idleHibernateMs: () =>
      effectiveEngineSettings(store).idleHibernateMs ??
      defaults.idleHibernateMs ??
      DEFAULT_IDLE_HIBERNATE_MS,
  };
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type ExportConfigDeps = {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
};

export async function exportEngineConfig(deps: ExportConfigDeps): Promise<ConfigBundle> {
  let modelsConfig: Record<string, unknown> | undefined;
  try {
    const text = await readFile(deps.layout.modelsFile, "utf8");
    modelsConfig = parseModelsConfig(text) as unknown as Record<string, unknown>;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return {
    version: 1,
    settings: readEngineSettings(deps.store),
    modelProfiles: readModelProfiles(deps.store),
    mcpServers: getMcpServersRecord(deps.store),
    ...(modelsConfig === undefined ? {} : { modelsConfig }),
  };
}

export type ImportConfigDeps = ExportConfigDeps & {
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  readonly syncProjects: () => Promise<void>;
  readonly applySettings: () => Promise<void>;
};

export async function importEngineConfig(
  deps: ImportConfigDeps,
  input: ConfigBundle,
): Promise<ConfigBundle> {
  const bundle = parseWithSchema(ConfigBundleSchema, input, "ConfigBundle");
  const parsedMcp = parseMcpConfig({ mcpServers: bundle.mcpServers });
  if (parsedMcp.errors.length > 0) {
    throw new EngineError(400, "invalid_mcp_config", parsedMcp.errors.join("; "));
  }

  let parsedModelsConfig: ReturnType<typeof parseModelsConfig> | undefined;
  if (bundle.modelsConfig !== undefined) {
    try {
      parsedModelsConfig = parseModelsConfig(JSON.stringify(bundle.modelsConfig));
      composeProviders(parsedModelsConfig, { env: deps.env });
    } catch (error) {
      if (error instanceof ModelsConfigError || error instanceof Error) {
        throw new EngineError(400, "invalid_models_config", error.message);
      }
      throw error;
    }
  }

  if (parsedModelsConfig !== undefined) {
    await writeTextAtomic(
      deps.layout.modelsFile,
      `${JSON.stringify(parsedModelsConfig, null, 2)}\n`,
    );
    await deps.modelRuntime.reload();
  }

  const normalizedMcp = normalizeMcpMap(parsedMcp.servers);
  deps.store.setKv(KV_SETTINGS, bundle.settings);
  deps.store.setKv(KV_MODEL_PROFILES, bundle.modelProfiles);
  deps.store.setKv(KV_MCP_SERVERS, normalizedMcp);

  await deps.mcpHub.reload(parsedMcp.servers);
  await deps.syncProjects();
  await deps.applySettings();
  return exportEngineConfig(deps);
}
