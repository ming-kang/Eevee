import type { Context } from "@earendil-works/chord/context";
import type { ProjectSummary } from "../api/contract.ts";
import type { ModelChoice, RoleName } from "../contracts/index.ts";
import { MemoryRepo } from "../extensions/memory/index.ts";
import { renderCatalog } from "../models/catalog.ts";
import type { ModelRuntime } from "../models/index.ts";
import { readText } from "../shared/fs.ts";
import type { EeveePaths } from "../shared/paths.ts";
import type { SettingsStore } from "../shared/settings.ts";
import { createProjectMeta, listProjects } from "./project.ts";
import { ProjectHost } from "./project-host.ts";

export type EngineOptions = {
  paths: EeveePaths;
  settings: SettingsStore;
  models: ModelRuntime;
  context: Context;
};

export class UnknownModel extends Error {
  override name = "UnknownModel";
}

export class Engine {
  readonly bootId = crypto.randomUUID();
  readonly #options: EngineOptions;
  readonly #globalMemory: MemoryRepo;
  readonly #projects = new Map<string, ProjectHost>();

  private constructor(options: EngineOptions) {
    this.#options = options;
    this.#globalMemory = new MemoryRepo(options.paths.globalMemory);
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const engine = new Engine(options);
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

  async catalog(): Promise<string> {
    return renderCatalog({
      models: this.#options.models.models(),
      credentials: this.#options.models.credentials,
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
    await Promise.all([...this.#projects.values()].map((host) => host.refreshRouterModel()));
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

  async close(): Promise<void> {
    await Promise.all([...this.#projects.values()].map((host) => host.close()));
    this.#projects.clear();
  }

  #openHost(meta: ProjectSummary): Promise<ProjectHost> {
    return ProjectHost.open({
      paths: this.#options.paths,
      meta,
      models: this.#options.models.models,
      settings: () => this.#options.settings.current,
      globalMemory: this.#globalMemory,
      context: this.#options.context,
      credentials: this.#options.models.credentials,
    });
  }
}
