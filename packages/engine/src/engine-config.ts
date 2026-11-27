import { readFile } from "node:fs/promises";
import { isMcpServerOverride } from "@earendil-works/pi-mcp";
import { map } from "@earendil-works/pi-schema";
import {
  isRecord,
  type McpHub,
  type McpOAuthCredentialStore,
  mcpOAuthStoreKey,
  normalizeMcpServerMap,
  parseMcpConfig,
} from "@eevee/agent";
import {
  composeProviders,
  type ModelRuntime,
  ModelsConfigError,
  parseModelsConfig,
  writeModelsJsonFile,
} from "@eevee/agent/models";
import type { ModelSlots } from "@eevee/core";
import {
  type ConfigBundle,
  ConfigBundleSchema,
  type EngineSettings,
  EngineSettingsSchema,
  type McpServerConfigPayload,
  McpServerConfigSchema,
  type McpServerEntryInput,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  parseWithSchema,
  type SkillPolicyMap,
  SkillPolicyMapSchema,
  type ToolsSettings,
} from "@eevee/protocol";
import type { DataDirLayout } from "./data-dir.ts";
import { EngineError } from "./engine-error.ts";
import { GLOBAL_MCP_OAUTH_SCOPE, projectMcpOAuthScope } from "./mcp-oauth-sessions.ts";
import type { EngineStore } from "./store.ts";

export const KV_SETTINGS = "settings";
export const KV_MODEL_PROFILES = "model_profiles";
export const KV_MCP_SERVERS = "mcp_servers";
export const KV_SKILLS_POLICY = "skills_policy";

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

const McpServersMapSchema = map(McpServerConfigSchema);

export function readEngineSettings(store: EngineStore): EngineSettings {
  return store.getKvParsed(KV_SETTINGS, EngineSettingsSchema) ?? {};
}

export function effectiveEngineSettings(store: EngineStore): EngineSettings {
  return readEngineSettings(store);
}

export function readModelProfiles(store: EngineStore): ModelProfilesDocument {
  return store.getKvParsed(KV_MODEL_PROFILES, ModelProfilesDocumentSchema) ?? { profiles: [] };
}

export function getMcpServersRecord(store: EngineStore): Record<string, McpServerConfigPayload> {
  return store.getKvParsed(KV_MCP_SERVERS, McpServersMapSchema) ?? {};
}

export function readGlobalSkillsPolicy(store: EngineStore): SkillPolicyMap {
  return store.getKvParsed(KV_SKILLS_POLICY, SkillPolicyMapSchema) ?? {};
}

export function effectiveSkillsPolicy(store: EngineStore, projectId: string): SkillPolicyMap {
  const globalPolicy = readGlobalSkillsPolicy(store);
  const projectPolicy = store.getProjectSkillsPolicy(projectId);
  if (projectPolicy === undefined) return globalPolicy;
  return { ...globalPolicy, ...projectPolicy };
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

export function putModelProfiles(
  store: EngineStore,
  doc: ModelProfilesDocument,
): ModelProfilesDocument {
  const validated = parseWithSchema(ModelProfilesDocumentSchema, doc, "ModelProfilesDocument");
  store.setKv(KV_MODEL_PROFILES, validated);
  return validated;
}

export async function patchEngineSettings(
  store: EngineStore,
  patch: EngineSettings,
  applySettings: () => Promise<void>,
): Promise<EngineSettings> {
  const validated = parseWithSchema(EngineSettingsSchema, patch, "EngineSettings");
  const next = mergeEngineSettings(readEngineSettings(store), validated);
  store.setKv(KV_SETTINGS, next);
  await applySettings();
  return next;
}

export async function putEngineSettings(
  store: EngineStore,
  next: EngineSettings,
  applySettings: () => Promise<void>,
): Promise<EngineSettings> {
  const validated = parseWithSchema(EngineSettingsSchema, next, "EngineSettings");
  store.setKv(KV_SETTINGS, validated);
  await applySettings();
  return validated;
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
  const skillsPolicy = deps.store.getKvParsed(KV_SKILLS_POLICY, SkillPolicyMapSchema);
  return {
    version: 1,
    settings: readEngineSettings(deps.store),
    modelProfiles: readModelProfiles(deps.store),
    mcpServers: getMcpServersRecord(deps.store),
    ...(skillsPolicy === undefined ? {} : { skillsPolicy }),
    ...(modelsConfig === undefined ? {} : { modelsConfig }),
  };
}

export type RemovedHttpMcpServer = {
  readonly name: string;
  readonly url: string;
};

export function httpUrlOfMcpRecord(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.url !== "string" || !URL.canParse(raw.url)) return undefined;
  if (raw.type !== undefined && raw.type !== "http" && raw.type !== "streamable-http") {
    return undefined;
  }
  return raw.url;
}

export function findRemovedHttpMcpServers(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): RemovedHttpMcpServer[] {
  const removed: RemovedHttpMcpServer[] = [];
  for (const [name, prevRaw] of Object.entries(previous)) {
    const prevUrl = httpUrlOfMcpRecord(prevRaw);
    if (prevUrl === undefined) continue;
    const nextRaw = Object.hasOwn(next, name) ? next[name] : undefined;
    const nextUrl = httpUrlOfMcpRecord(nextRaw);
    if (
      nextUrl === undefined ||
      mcpOAuthStoreKey(name, prevUrl) !== mcpOAuthStoreKey(name, nextUrl)
    ) {
      removed.push({ name, url: prevUrl });
    }
  }
  return removed;
}

function collectReferencedOAuthKeys(store: EngineStore): Set<string> {
  const keys = new Set<string>();
  const addFromMap = (servers: Readonly<Record<string, unknown>>) => {
    for (const [name, raw] of Object.entries(servers)) {
      const url = httpUrlOfMcpRecord(raw);
      if (url !== undefined) {
        keys.add(mcpOAuthStoreKey(name, url));
      }
    }
  };
  addFromMap(getMcpServersRecord(store));
  for (const project of store.listProjects()) {
    const projectServers = store.getProjectMcpServers(project.id);
    if (projectServers !== undefined) {
      addFromMap(projectServers);
    }
  }
  return keys;
}

export function pruneOrphanProjectMcpOverrides(
  store: EngineStore,
  nextGlobalServers: Readonly<Record<string, unknown>>,
): void {
  for (const project of store.listProjects()) {
    const projectServers = store.getProjectMcpServers(project.id);
    if (projectServers === undefined) continue;
    let changed = false;
    const nextProjectServers: Record<string, McpServerEntryInput> = {};
    for (const [name, raw] of Object.entries(projectServers)) {
      if (isRecord(raw) && isMcpServerOverride(raw) && !Object.hasOwn(nextGlobalServers, name)) {
        changed = true;
        continue;
      }
      nextProjectServers[name] = raw;
    }
    if (changed) {
      store.setProjectMcpServers(
        project.id,
        Object.keys(nextProjectServers).length === 0 ? null : nextProjectServers,
      );
    }
  }
}

export type OAuthCancellationScope = {
  readonly scopeKey: string;
  readonly serverNames: readonly string[];
};

export function collectGlobalMcpOAuthCancellations(
  store: EngineStore,
  removedGlobalHttp: readonly RemovedHttpMcpServer[],
): OAuthCancellationScope[] {
  if (removedGlobalHttp.length === 0) return [];
  const scopes: OAuthCancellationScope[] = [
    {
      scopeKey: GLOBAL_MCP_OAUTH_SCOPE,
      serverNames: removedGlobalHttp.map((entry) => entry.name),
    },
  ];
  for (const project of store.listProjects()) {
    const projectServers = store.getProjectMcpServers(project.id) ?? {};
    const inheritedNames = removedGlobalHttp
      .filter((entry) => {
        const raw = projectServers[entry.name];
        return raw === undefined || (isRecord(raw) && isMcpServerOverride(raw));
      })
      .map((entry) => entry.name);
    if (inheritedNames.length > 0) {
      scopes.push({
        scopeKey: projectMcpOAuthScope(project.id),
        serverNames: inheritedNames,
      });
    }
  }
  return scopes;
}

export type CleanupRemovedMcpOAuthOptions = {
  readonly store: EngineStore;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly cancelOAuthForServers: (
    serverNames: readonly string[],
    scopeKey?: string,
  ) => Promise<void>;
  readonly removed: readonly RemovedHttpMcpServer[];
  readonly cancelServerNames?: readonly string[];
  readonly cancellations?: readonly OAuthCancellationScope[];
};

export async function cleanupRemovedMcpOAuth(
  options: CleanupRemovedMcpOAuthOptions,
): Promise<void> {
  if (options.cancellations !== undefined) {
    for (const scope of options.cancellations) {
      if (scope.serverNames.length > 0) {
        await options.cancelOAuthForServers(scope.serverNames, scope.scopeKey);
      }
    }
  } else {
    const cancelNames = options.cancelServerNames ?? options.removed.map((entry) => entry.name);
    if (cancelNames.length > 0) {
      await options.cancelOAuthForServers(cancelNames);
    }
  }
  if (options.removed.length === 0) return;

  const referencedKeys = collectReferencedOAuthKeys(options.store);
  const removedKeys = new Set<string>();
  for (const entry of options.removed) {
    const key = mcpOAuthStoreKey(entry.name, entry.url);
    if (removedKeys.has(key) || referencedKeys.has(key)) continue;
    removedKeys.add(key);
    await options.oauthStore.remove(entry.name, entry.url);
  }
}

export type ImportConfigDeps = ExportConfigDeps & {
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly cancelOAuthForServers: (
    serverNames: readonly string[],
    scopeKey?: string,
  ) => Promise<void>;
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
    await writeModelsJsonFile(deps.layout.modelsFile, parsedModelsConfig);
    await deps.modelRuntime.reload();
  }

  const normalizedMcp = normalizeMcpServerMap(parsedMcp.servers);
  const { removedHttpMcp, cancellations } = deps.store.transaction(() => {
    const previousMcp = getMcpServersRecord(deps.store);
    const removed = findRemovedHttpMcpServers(previousMcp, normalizedMcp);
    const scopes = collectGlobalMcpOAuthCancellations(deps.store, removed);
    deps.store.setKv(KV_SETTINGS, bundle.settings);
    deps.store.setKv(KV_MODEL_PROFILES, bundle.modelProfiles);
    deps.store.setKv(KV_MCP_SERVERS, normalizedMcp);
    pruneOrphanProjectMcpOverrides(deps.store, normalizedMcp);
    if (bundle.skillsPolicy !== undefined) {
      deps.store.setKv(KV_SKILLS_POLICY, bundle.skillsPolicy);
    } else {
      deps.store.deleteKv(KV_SKILLS_POLICY);
    }
    return { removedHttpMcp: removed, cancellations: scopes };
  });

  await cleanupRemovedMcpOAuth({
    store: deps.store,
    oauthStore: deps.oauthStore,
    cancelOAuthForServers: deps.cancelOAuthForServers,
    removed: removedHttpMcp,
    cancellations,
  });

  await deps.mcpHub.reload(parsedMcp.servers);
  await deps.syncProjects();
  await deps.applySettings();
  return exportEngineConfig(deps);
}
