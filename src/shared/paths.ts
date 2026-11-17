import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export function resolveInside(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(base, rel) !== target) {
    throw new Error(`路径必须位于 ${base} 之内：${path}`);
  }
  return target;
}

export type ProjectPaths = {
  root: string;
  meta: string;
  session: string;
  memory: string;
  jobs: string;
};

export type EeveePaths = {
  home: string;
  settings: string;
  auth: string;
  models: string;
  modelProfiles: string;
  globalMemory: string;
  runtime: {
    dir: string;
    lock: string;
    record: string;
    cliToken: string;
    sessions: string;
  };
  projects: string;
  project(id: string): ProjectPaths;
};

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.EEVEE_HOME ?? join(homedir(), ".eevee"));
}

export function eeveePaths(home: string = resolveHome()): EeveePaths {
  const runtime = join(home, "runtime");
  const projects = join(home, "projects");
  return {
    home,
    settings: join(home, "settings.json"),
    auth: join(home, "auth.json"),
    models: join(home, "models.json"),
    modelProfiles: join(home, "models.md"),
    globalMemory: join(home, "memory"),
    runtime: {
      dir: runtime,
      lock: join(runtime, "engine.lock"),
      record: join(runtime, "engine.json"),
      cliToken: join(runtime, "cli-token"),
      sessions: join(runtime, "sessions.json"),
    },
    projects,
    project: (id) => projectPaths(join(projects, id)),
  };
}

export function projectPaths(root: string): ProjectPaths {
  return {
    root,
    meta: join(root, "project.json"),
    session: join(root, "session.sqlite"),
    memory: join(root, "memory"),
    jobs: join(root, "jobs"),
  };
}
