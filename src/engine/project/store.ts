import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { JsonFileStore } from "../../config/json-file-store.ts";
import { ModelDefaultsSchema } from "../../config/settings.ts";
import type { ProjectSummary } from "../../protocol/contract.ts";
import { readJson, writeJsonAtomic } from "../../shared/fs.ts";
import type { EeveePaths } from "../../shared/paths.ts";

export type ProjectMeta = ProjectSummary;

export const ProjectMetaSchema = obj({
  id: str({ minLength: 1 }),
  title: str({ minLength: 1 }),
  workspace: str({ minLength: 1 }),
  createdAt: num({ minimum: 0 }),
  activeAt: opt(num({ minimum: 0 })),
  models: opt(ModelDefaultsSchema),
});

export async function listProjects(paths: EeveePaths): Promise<ProjectMeta[]> {
  let ids: string[];
  try {
    ids = await readdir(paths.projects);
  } catch {
    return [];
  }
  const metas = await Promise.all(ids.map((id) => readJson<ProjectMeta>(paths.project(id).meta)));
  return metas.filter((meta) => meta !== undefined).sort((a, b) => a.createdAt - b.createdAt);
}

export async function createProjectMeta(
  paths: EeveePaths,
  input: { title: string; workspace: string },
): Promise<ProjectMeta> {
  const meta: ProjectMeta = {
    id: `p${randomBytes(4).toString("hex")}`,
    title: input.title,
    workspace: input.workspace,
    createdAt: Date.now(),
  };
  await saveProjectMeta(paths, meta);
  return meta;
}

export async function saveProjectMeta(paths: EeveePaths, meta: ProjectMeta): Promise<void> {
  await writeJsonAtomic(paths.project(meta.id).meta, meta);
}

export class ProjectStore {
  readonly #store: JsonFileStore<typeof ProjectMetaSchema>;

  private constructor(path: string, current: ProjectMeta) {
    this.#store = new JsonFileStore(ProjectMetaSchema, path, current);
  }

  static open(paths: EeveePaths, meta: ProjectMeta): ProjectStore {
    return new ProjectStore(paths.project(meta.id).meta, meta);
  }

  get current(): ProjectMeta {
    return this.#store.current;
  }

  update(change: (meta: ProjectMeta) => ProjectMeta): Promise<ProjectMeta> {
    return this.#store.update(change);
  }
}
