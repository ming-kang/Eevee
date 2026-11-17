import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { ProjectSummary } from "../api/contract.ts";
import { readJson, writeJsonAtomic } from "../shared/fs.ts";
import type { EeveePaths } from "../shared/paths.ts";

export type ProjectMeta = ProjectSummary;

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
  await writeJsonAtomic(paths.project(meta.id).meta, meta);
  return meta;
}
