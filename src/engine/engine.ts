import type { Context } from "@earendil-works/chord/context";
import type { CapabilitiesView, ProjectSummary } from "../api/contract.ts";
import { type ModelChoice, ROLE_NAMES, type RoleName } from "../contracts/index.ts";
import { MemoryRepo } from "../extensions/memory/index.ts";
import { renderCatalog } from "../models/catalog.ts";
import type { ModelRuntime } from "../models/index.ts";
import { roleExtensions } from "../roles/index.ts";
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

export class UnknownModel extends Error {
  override name = "UnknownModel";
}

export class UnknownExtension extends Error {
  override name = "UnknownExtension";
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
    return [...this.#projects.values()].map((host) => host.meta);
  }

  project(id: string): ProjectHost | undefined {
    return this.#projects.get(id);
  }

  async createProject(input: { title: string; workspace: string }): Promise<ProjectSummary> {
    const meta = await createProjectMeta(this.#options.paths, input);
    this.#projects.set(meta.id, await this.#openHost(meta));
    return meta;
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  async catalog(): Promise<string> {
    return renderCatalog({
      models: this.#options.models.models(),
      defaults: this.#options.settings.current.models,
      profiles: await readText(this.#options.paths.modelProfiles),
    });
  }

  async setDefaultModel(role: RoleName | "default", choice: ModelChoice): Promise<void> {
    if (this.#options.models.models().getModel(choice.provider, choice.modelId) === undefined) {
      throw new UnknownModel(`没有模型 ${choice.provider}/${choice.modelId}`);
    }
    await this.#options.settings.update((stored) => ({
      ...stored,
      models: { ...stored.models, [role]: choice },
    }));
    await this.#refreshProjects();
  }

  async login(provider: string, key: string): Promise<void> {
    if (this.#options.models.models().getProvider(provider) === undefined) {
      throw new UnknownModel(`没有 provider ${provider}`);
    }
    await this.#options.models.credentials.modify(provider, async () => ({
      type: "api_key",
      key,
    }));
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

  /** Enables extensions for a role, by name, in every project. Names must be installed now. */
  async setRoleCapability(role: RoleName, change: RoleCapabilityChange): Promise<CapabilitiesView> {
    if (change.extensions !== undefined) {
      const known = new Set(
        this.#requireShared()
          .list()
          .map((e) => e.name),
      );
      const unknown = change.extensions.filter((name) => !known.has(name));
      if (unknown.length > 0) throw new UnknownExtension(`没有安装扩展：${unknown.join("、")}`);
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

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Closes the shared extensions first, so no change of theirs reaches a project that is closing. */
  async close(): Promise<void> {
    await this.#shared?.close();
    await Promise.all([...this.#projects.values()].map((host) => host.close()));
    this.#projects.clear();
  }

  #requireShared(): SharedExtensions {
    if (this.#shared === undefined) throw new Error("Engine 尚未打开");
    return this.#shared;
  }

  async #refreshProjects(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((host) =>
        host.refreshExtensions().catch((error: unknown) => {
          console.error(`[${host.meta.id}] 更新扩展失败`, error);
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
