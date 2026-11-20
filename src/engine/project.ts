import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { ProjectSummary } from "../api/contract.ts";
import { parseConfig } from "../shared/config.ts";
import { readJson, writeJsonAtomic } from "../shared/fs.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { ModelDefaultsSchema } from "../shared/settings.ts";

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

/** `project.json`'s single writer after `saveProjectMeta`: changes are queued, validated and written atomically. */
export class ProjectStore {
  readonly #path: string;
  #current: ProjectMeta;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, current: ProjectMeta) {
    this.#path = path;
    this.#current = current;
  }

  static open(paths: EeveePaths, meta: ProjectMeta): ProjectStore {
    return new ProjectStore(paths.project(meta.id).meta, meta);
  }

  get current(): ProjectMeta {
    return this.#current;
  }

  update(change: (meta: ProjectMeta) => ProjectMeta): Promise<ProjectMeta> {
    const next = this.#queue.then(async () => {
      const raw = (await readJson<unknown>(this.#path)) ?? this.#current;
      const current = parseConfig(ProjectMetaSchema, raw, this.#path);
      const meta = parseConfig(ProjectMetaSchema, change(current), this.#path);
      await writeJsonAtomic(this.#path, meta);
      this.#current = meta;
      return meta;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
