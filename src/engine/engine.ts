import type { Context } from "@earendil-works/chord/context";
import type { SettingsStore } from "../config/settings.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { CapabilityService } from "./capability-service.ts";
import { MemoryStore } from "./memory/store.ts";
import { ModelService } from "./model-service.ts";
import type { ModelRuntime } from "./models/index.ts";
import { INITIAL_GLOBAL_MEMORY } from "./project/memory.ts";
import { openProject } from "./project/open.ts";
import { ProjectRegistry } from "./project-registry.ts";
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

export class Engine {
  readonly bootId = crypto.randomUUID();
  readonly startedAt = Date.now();
  readonly projects: ProjectRegistry;
  readonly models: ModelService;
  readonly capabilities: CapabilityService;
  readonly memory: MemoryStore;
  readonly #shared: SharedExtensions;

  private constructor(
    projects: ProjectRegistry,
    models: ModelService,
    capabilities: CapabilityService,
    shared: SharedExtensions,
    memory: MemoryStore,
  ) {
    this.projects = projects;
    this.models = models;
    this.capabilities = capabilities;
    this.#shared = shared;
    this.memory = memory;
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const globalMemory = new MemoryStore(options.paths.globalMemory, "global");
    await globalMemory.ensure(INITIAL_GLOBAL_MEMORY);
    let shared: SharedExtensions | undefined;
    const projects = new ProjectRegistry({
      paths: options.paths,
      open: (meta, changed) =>
        openProject({
          changed,
          paths: options.paths,
          meta,
          models: options.models.models,
          settings: () => options.settings.current,
          globalMemory,
          shared: () => {
            if (shared === undefined) throw new Error("The Engine is not open yet");
            return shared.list();
          },
          context: options.context,
        }),
    });
    try {
      shared = await SharedExtensions.open({
        paths: options.paths,
        client: options.client ?? { name: "eevee", version: "0.0.0" },
        onChange: () => void projects.refreshExtensions(),
        ...(options.openMcp === undefined ? {} : { openMcp: options.openMcp }),
      });
      const models = new ModelService({
        paths: options.paths,
        settings: options.settings,
        runtime: options.models,
        projects,
      });
      const capabilities = new CapabilityService({
        shared,
        settings: options.settings,
        refreshProjects: () => projects.refreshExtensions(),
      });
      await projects.initialize();
      return new Engine(projects, models, capabilities, shared, globalMemory);
    } catch (error) {
      await Promise.allSettled([projects.close(), ...(shared ? [shared.close()] : [])]);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#shared.close();
    await this.projects.close();
  }
}
