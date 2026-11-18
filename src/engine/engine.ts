import type { Context } from "@earendil-works/chord/context";
import type {
  CapabilitiesView,
  ModelsView,
  ProbeModelsInput,
  ProjectSummary,
} from "../api/contract.ts";
import { type ModelChoice, ProblemError, ROLE_NAMES, type RoleName } from "../contracts/index.ts";
import { mcpExtensionName } from "../extensions/mcp/index.ts";
import { MemoryRepo } from "../extensions/memory/index.ts";
import { type BuiltinModelRef, matchBuiltinModels } from "../models/builtin-catalog.ts";
import { buildModelsView } from "../models/catalog.ts";
import type { ModelRuntime } from "../models/index.ts";
import type { ProviderConfig } from "../models/models-config.ts";
import { type ProbeResult, probeModels } from "../models/probe.ts";
import { roleExtensions } from "../roles/index.ts";
import { ConfigError, processEnv, resolveConfigValue } from "../shared/config.ts";
import { readText } from "../shared/fs.ts";
import type { EeveePaths } from "../shared/paths.ts";
import type { RoleSettings, SettingsStore } from "../shared/settings.ts";
import { createProjectMeta, listProjects } from "./project.ts";
import { ProjectHost } from "./project-host.ts";
import { SharedExtensions, type SharedExtensionsOptions } from "./shared-extensions.ts";

export type EngineOptions = {
  paths: EeveePaths;
  settings: SettingsStore;
  models: ModelRuntime;
  context: Context;
  /** Client identity Eevee gives MCP servers. */
  client?: { name: string; version: string };
  /** Opens an MCP server's transport; tests pass an in-memory one. */
  openMcp?: SharedExtensionsOptions["openMcp"];
};

/** Provider ids go into URLs and `provider/model` references: no spaces, slashes or leading punctuation. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An mcp.json the Engine could not read or change, as a refusal naming what is wrong. */
async function mcpProblem<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ProblemError({ code: "bad_config", problems: error.problems });
    }
    if (error instanceof SyntaxError) {
      throw new ProblemError({
        code: "bad_config",
        problems: [{ file: "mcp.json", code: "failed", detail: error.message }],
      });
    }
    throw error;
  }
}

/** A change to one role's capabilities; `maxTurns: null` goes back to Durable's default. */
export type RoleCapabilityChange = { extensions?: readonly string[]; maxTurns?: number | null };

/** Every project, and what they share: the settings, the models, the global memory and the shared extensions. */
export class Engine {
  readonly bootId = crypto.randomUUID();
  readonly #options: EngineOptions;
  readonly #globalMemory: MemoryRepo;
  readonly #projects = new Map<string, ProjectHost>();
  #shared: SharedExtensions | undefined;

  private constructor(options: EngineOptions) {
    this.#options = options;
    this.#globalMemory = new MemoryRepo(options.paths.globalMemory);
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const engine = new Engine(options);
    engine.#shared = await SharedExtensions.open({
      paths: options.paths,
      client: options.client ?? { name: "eevee", version: "0.0.0" },
      onChange: () => void engine.#refreshProjects(),
      ...(options.openMcp === undefined ? {} : { openMcp: options.openMcp }),
    });
    for (const meta of await listProjects(options.paths)) {
      engine.#projects.set(meta.id, await engine.#openHost(meta));
    }
    return engine;
  }

  projects(): ProjectSummary[] {
    return [...this.#projects.values()].map((host) => host.summary());
  }

  project(id: string): ProjectHost | undefined {
    return this.#projects.get(id);
  }

  async createProject(input: { title: string; workspace: string }): Promise<ProjectSummary> {
    const meta = await createProjectMeta(this.#options.paths, input);
    const host = await this.#openHost(meta);
    this.#projects.set(meta.id, host);
    return host.summary();
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  async catalog(): Promise<ModelsView> {
    return buildModelsView({
      models: this.#options.models.models(),
      defaults: this.#options.settings.current.models,
      profiles: await readText(this.#options.paths.modelProfiles),
      customProviders: this.#options.models.customProviders(),
      builtinProviders: this.#options.models.builtinProviders(),
      problems: this.#options.models.problems(),
    });
  }

  /** The providers models.json configures, as written. */
  modelsConfig(): Promise<Record<string, ProviderConfig>> {
    return this.#options.models.providerConfigs();
  }

  /**
   * Writes a provider's models.json entry; `undefined` removes it, which puts a built-in provider back as it
   * came and drops a custom one along with its saved key. A model a default uses must stay.
   */
  async saveProvider(id: string, entry: ProviderConfig | undefined): Promise<ModelsView> {
    const runtime = this.#options.models;
    const known = runtime.builtinProviders().has(id) || id in (await runtime.providerConfigs());
    if (!known && !PROVIDER_ID.test(id)) {
      throw new ProblemError({ code: "invalid", field: "provider" });
    }
    await runtime.setProviderConfig(id, entry, this.#modelsInUse(id));
    if (entry === undefined && !runtime.builtinProviders().has(id)) {
      await runtime.credentials.delete(id);
      await runtime.reload();
    }
    await this.#applyModels();
    return this.catalog();
  }

  /** The built-in models closest to `query`, those on `api` first: references to copy a model entry's fields from. */
  builtinModels(query: string, api?: string): BuiltinModelRef[] {
    return matchBuiltinModels(this.#options.models.builtinCatalog(), query, api);
  }

  /** Lists the models an endpoint serves; the key falls back to the provider's own credentials. */
  async probeModels(input: ProbeModelsInput): Promise<ProbeResult> {
    const models = this.#options.models.models();
    const saved =
      input.key === undefined && input.provider !== undefined
        ? await models.getAuth(input.provider).catch(() => undefined)
        : undefined;
    const key =
      input.key === undefined
        ? saved?.auth.apiKey
        : await resolveConfigValue(input.key, processEnv);
    const headers: Record<string, string | null> = { ...saved?.auth.headers };
    for (const [name, raw] of Object.entries(input.headers ?? {})) {
      const value = await resolveConfigValue(raw, processEnv);
      if (value !== undefined) headers[name] = value;
    }
    return probeModels({
      baseUrl: input.baseUrl,
      ...(input.api === undefined ? {} : { api: input.api }),
      auth: { ...(key === undefined ? {} : { apiKey: key }), headers },
    });
  }

  /** The models of `provider` that a default, global or a project's, names. */
  #modelsInUse(provider: string): string[] {
    const choices = [
      ...Object.values(this.#options.settings.current.models),
      ...this.projects().flatMap((p) => Object.values(p.models ?? {})),
    ];
    return [
      ...new Set(choices.filter((c) => c?.provider === provider).map((c) => c?.modelId ?? "")),
    ];
  }

  async setDefaultModel(role: RoleName | "default", choice: ModelChoice): Promise<void> {
    this.#requireModel(choice);
    await this.#options.settings.update((stored) => ({
      ...stored,
      models: { ...stored.models, [role]: choice },
    }));
    await this.#applyModels();
  }

  /** A project's own model for a role over the settings' default; `null` follows the settings again. */
  async setProjectModel(
    host: ProjectHost,
    role: RoleName | "default",
    choice: ModelChoice | null,
  ): Promise<ProjectSummary> {
    if (choice !== null) this.#requireModel(choice);
    await host.setProjectModel(role, choice);
    return host.summary();
  }

  #requireModel(choice: ModelChoice): void {
    if (this.#options.models.models().getModel(choice.provider, choice.modelId) === undefined) {
      throw new ProblemError({ code: "no_model", ...choice });
    }
  }

  async login(provider: string, key: string): Promise<void> {
    if (this.#options.models.models().getProvider(provider) === undefined) {
      throw new ProblemError({ code: "no_provider", provider });
    }
    await this.#options.models.credentials.modify(provider, async () => ({
      type: "api_key",
      key,
    }));
    await this.#options.models.reload();
  }

  /** Removes the key saved for a provider; other credential sources stay as they are. */
  async logout(provider: string): Promise<void> {
    await this.#options.models.credentials.delete(provider);
    await this.#options.models.reload();
  }

  // ── Capabilities ───────────────────────────────────────────────────────────

  capabilities(): CapabilitiesView {
    const shared = this.#requireShared();
    const settings = this.#options.settings.current;
    return {
      available: shared.list().map((e) => ({ name: e.name, tools: e.tools?.length ?? 0 })),
      roles: ROLE_NAMES.map((role) => {
        const own: RoleSettings = settings.roles[role] ?? {};
        return {
          role,
          builtIn: roleExtensions(role),
          enabled: own.extensions ?? [],
          ...(own.maxTurns === undefined ? {} : { maxTurns: own.maxTurns }),
        };
      }),
      mcp: shared.mcpServers(),
      userExtensions: shared.userExtensions(),
      problems: shared.problems(),
    };
  }

  /**
   * Enables extensions for a role, by name, in every project. A newly enabled name must be installed now; one the
   * role already enables may have been uninstalled since, and is kept or dropped without blocking the change.
   */
  async setRoleCapability(role: RoleName, change: RoleCapabilityChange): Promise<CapabilitiesView> {
    if (change.extensions !== undefined) {
      const known = new Set(
        this.#requireShared()
          .list()
          .map((e) => e.name),
      );
      const enabled = this.#options.settings.current.roles[role]?.extensions ?? [];
      const unknown = change.extensions.filter(
        (name) => !known.has(name) && !enabled.includes(name),
      );
      if (unknown.length > 0) throw new ProblemError({ code: "no_extension", names: unknown });
    }
    await this.#options.settings.update((stored) => {
      const current = stored.roles?.[role] ?? {};
      const next: RoleSettings = { ...current };
      if (change.extensions !== undefined) next.extensions = [...new Set(change.extensions)];
      if (change.maxTurns === null) delete next.maxTurns;
      else if (change.maxTurns !== undefined) next.maxTurns = change.maxTurns;
      return { ...stored, roles: { ...stored.roles, [role]: next } };
    });
    await this.#refreshProjects();
    return this.capabilities();
  }

  /** Reads mcp.json again and reconnects; servers come back in the background. */
  async reloadMcp(): Promise<CapabilitiesView> {
    await this.#requireShared().reloadMcp();
    return this.capabilities();
  }

  /** mcp.json's server entries as written. */
  mcpConfig(): Promise<Record<string, unknown>> {
    return mcpProblem(this.#requireShared().mcpEntries());
  }

  /**
   * Writes one MCP server's entry and reconnects it, the others staying connected. Removing a server also takes
   * it off every role that enabled it.
   */
  async saveMcpServer(
    name: string,
    entry: Record<string, unknown> | undefined,
  ): Promise<CapabilitiesView> {
    await mcpProblem(this.#requireShared().saveMcpServer(name, entry));
    if (entry === undefined) {
      const extension = mcpExtensionName(name);
      const enabling = ROLE_NAMES.filter((role) =>
        this.#options.settings.current.roles[role]?.extensions?.includes(extension),
      );
      if (enabling.length > 0) {
        await this.#options.settings.update((stored) => {
          const roles = { ...stored.roles };
          for (const role of enabling) {
            const own = roles[role] ?? {};
            roles[role] = {
              ...own,
              extensions: (own.extensions ?? []).filter((e) => e !== extension),
            };
          }
          return { ...stored, roles };
        });
        await this.#refreshProjects();
      }
    }
    return this.capabilities();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Closes the shared extensions first, so no change of theirs reaches a project that is closing. */
  async close(): Promise<void> {
    await this.#shared?.close();
    await Promise.all([...this.#projects.values()].map((host) => host.close()));
    this.#projects.clear();
  }

  #requireShared(): SharedExtensions {
    if (this.#shared === undefined) throw new Error("The Engine isn't open yet");
    return this.#shared;
  }

  async #applyModels(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((host) =>
        host.applyModels().catch((error: unknown) => {
          console.error(`[${host.meta.id}] failed to apply models`, error);
        }),
      ),
    );
  }

  async #refreshProjects(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((host) =>
        host.refreshExtensions().catch((error: unknown) => {
          console.error(`[${host.meta.id}] failed to refresh extensions`, error);
        }),
      ),
    );
  }

  #openHost(meta: ProjectSummary): Promise<ProjectHost> {
    return ProjectHost.open({
      paths: this.#options.paths,
      meta,
      models: this.#options.models.models,
      settings: () => this.#options.settings.current,
      globalMemory: this.#globalMemory,
      shared: () => this.#requireShared().list(),
      context: this.#options.context,
    });
  }
}
