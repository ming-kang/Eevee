import { ProblemError } from "../domain/index.ts";
import type { ProjectSummary } from "../protocol/contract.ts";
import type { EeveePaths } from "../shared/paths.ts";
import type { Project } from "./project/project.ts";
import { createProjectMeta, listProjects } from "./project/store.ts";

type Deps = {
  paths: EeveePaths;
  open: (meta: ProjectSummary, changed: () => void) => Promise<Project>;
};

export class ProjectRegistry {
  readonly #deps: Deps;
  readonly #projects = new Map<string, Project>();
  readonly #listeners = new Set<(projects: ProjectSummary[]) => void>();
  #pending: ReturnType<typeof setImmediate> | undefined;

  #changed = (): void => {
    if (this.#pending !== undefined) return;
    this.#pending = setImmediate(() => {
      this.#pending = undefined;
      const projects = this.list();
      for (const listener of this.#listeners) listener(projects);
    });
  };

  watch(listener: (projects: ProjectSummary[]) => void): () => void {
    let previous = "";
    const changed = (projects: ProjectSummary[]) => {
      const value = JSON.stringify(projects);
      if (value === previous) return;
      previous = value;
      listener(projects);
    };
    this.#listeners.add(changed);
    changed(this.list());
    return () => {
      this.#listeners.delete(changed);
    };
  }

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async initialize(): Promise<void> {
    for (const meta of await listProjects(this.#deps.paths)) {
      this.#projects.set(meta.id, await this.#deps.open(meta, this.#changed));
    }
  }

  list(): ProjectSummary[] {
    return [...this.#projects.values()].map((project) => project.summary());
  }

  get(id: string): Project | undefined {
    return this.#projects.get(id);
  }

  require(id: string): Project {
    const project = this.get(id);
    if (project === undefined) throw new ProblemError({ code: "no_project", projectId: id });
    return project;
  }

  async create(input: { title: string; workspace: string }): Promise<ProjectSummary> {
    const meta = await createProjectMeta(this.#deps.paths, input);
    const project = await this.#deps.open(meta, this.#changed);
    this.#projects.set(meta.id, project);
    this.#changed();
    return project.summary();
  }

  async applyModels(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((project) =>
        project.applyModels().catch((error: unknown) => {
          console.error(`[${project.meta.id}] Could not apply the new models.`, error);
        }),
      ),
    );
  }

  async refreshExtensions(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((project) =>
        project.refreshExtensions().catch((error: unknown) => {
          console.error(`[${project.meta.id}] Could not refresh the extensions.`, error);
        }),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.#pending !== undefined) clearImmediate(this.#pending);
    this.#listeners.clear();
    await Promise.all([...this.#projects.values()].map((project) => project.close()));
    this.#projects.clear();
  }
}
