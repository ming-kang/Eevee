import { randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema";
import { JsonFileStore } from "../../config/json-file-store.ts";
import { ModelDefaultsSchema } from "../../config/settings.ts";
import { ProblemError } from "../../domain/index.ts";
import type { ProjectSummary } from "../../protocol/contract.ts";
import { readJson, writeJsonAtomic } from "../../shared/fs.ts";
import { type EeveePaths, workspaceKey } from "../../shared/paths.ts";

export type ProjectMeta = ProjectSummary;

export const ProjectMetaSchema = obj({
  id: str({ minLength: 1 }),
  title: str({ minLength: 1 }),
  workspaces: arr(str({ minLength: 1 }), { minItems: 1 }),
  createdAt: num({ minimum: 0 }),
  activeAt: opt(num({ minimum: 0 })),
  models: opt(ModelDefaultsSchema),
});

/** A metas read off disk may still carry the single `workspace` of the first releases. */
type RawMeta = Omit<ProjectMeta, "workspaces"> & {
  workspaces?: string[];
  workspace?: string;
};

function migrateMeta(raw: RawMeta): ProjectMeta | undefined {
  const { workspace, workspaces, ...rest } = raw;
  if (workspaces !== undefined && workspaces.length > 0) return { ...rest, workspaces };
  return typeof workspace === "string" && workspace !== ""
    ? { ...rest, workspaces: [workspace] }
    : undefined;
}

export async function listProjects(paths: EeveePaths): Promise<ProjectMeta[]> {
  let ids: string[];
  try {
    ids = await readdir(paths.projects);
  } catch {
    return [];
  }
  const metas = await Promise.all(
    ids.map(async (id) => {
      const raw = await readJson<RawMeta>(paths.project(id).meta);
      if (raw === undefined) return undefined;
      const meta = migrateMeta(raw);
      // Persist the migrated shape so every later read, including update()'s, sees only workspaces.
      if (meta !== undefined && raw.workspace !== undefined)
        await saveProjectMeta(paths, meta).catch(() => undefined);
      return meta;
    }),
  );
  return metas.filter((meta) => meta !== undefined).sort((a, b) => a.createdAt - b.createdAt);
}

/** Each directory resolved and checked against the file system, duplicates dropped in spelling order. */
export async function resolveWorkspaces(dirs: readonly string[]): Promise<string[]> {
  const workspaces: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (trimmed === "") throw new ProblemError({ code: "required", field: "workspaces" });
    const resolved = resolve(trimmed);
    const key = workspaceKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOTDIR") throw new ProblemError({ code: "not_dir", path: resolved });
      if (error?.code === "ENOENT") throw new ProblemError({ code: "no_dir", path: resolved });
      throw error;
    });
    if (!info.isDirectory()) throw new ProblemError({ code: "not_dir", path: resolved });
    workspaces.push(resolved);
  }
  if (workspaces.length === 0) throw new ProblemError({ code: "required", field: "workspaces" });
  return workspaces;
}

export async function createProjectMeta(
  paths: EeveePaths,
  input: { title: string; workspaces: readonly string[] },
): Promise<ProjectMeta> {
  const meta: ProjectMeta = {
    id: `p${randomBytes(4).toString("hex")}`,
    title: input.title,
    workspaces: await resolveWorkspaces(input.workspaces),
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
