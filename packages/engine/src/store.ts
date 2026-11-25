import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CreateProjectRequest, ModelSlotsOverride, ProjectSummary } from "@eevee/protocol";

export type UpdateProjectInput = {
  readonly title?: string;
  readonly workspaces?: readonly string[];
  readonly memory?: string | null;
  readonly models?: ModelSlotsOverride | null;
};

type ProjectRow = {
  readonly id: string;
  readonly title: string;
  readonly workspaces_json: string;
  readonly memory: string | null;
  readonly models_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type KvRow = {
  readonly value_json: string;
};

function baseSlug(source: string): string {
  const sanitized = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-.]+$/, "");
  const trimmed = sanitized.slice(0, 52).replace(/[-.]+$/, "");
  return trimmed.length > 0 ? trimmed : "project";
}

function rowToProject(row: ProjectRow): ProjectSummary {
  const workspaces = JSON.parse(row.workspaces_json) as string[];
  const models =
    row.models_json === null ? undefined : (JSON.parse(row.models_json) as ModelSlotsOverride);
  return {
    id: row.id,
    title: row.title,
    workspaces,
    ...(row.memory === null ? {} : { memory: row.memory }),
    ...(models === undefined ? {} : { models }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeWorkspaces(workspaces: readonly string[]): string[] {
  if (workspaces.length === 0) {
    throw new Error("Project requires at least one workspace");
  }
  const resolved: string[] = [];
  for (const workspace of workspaces) {
    const trimmed = workspace.trim();
    if (trimmed.length === 0) {
      throw new Error("Workspace path cannot be empty");
    }
    resolved.push(resolve(trimmed));
  }
  return resolved;
}

export class EngineStore {
  readonly #db: DatabaseSync;
  #closed = false;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(dbPath: string): EngineStore {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspaces_json TEXT NOT NULL,
        memory TEXT,
        models_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    return new EngineStore(db);
  }

  createProject(input: CreateProjectRequest): ProjectSummary {
    const workspaces = normalizeWorkspaces(input.workspaces);
    const firstWorkspace = workspaces[0];
    if (firstWorkspace === undefined) {
      throw new Error("Project requires at least one workspace");
    }
    const title = input.title?.trim() || basename(firstWorkspace) || firstWorkspace;
    const base = baseSlug(title);
    const now = Date.now();
    const workspacesJson = JSON.stringify(workspaces);
    const memory = input.memory ?? null;
    const modelsJson = input.models === undefined ? null : JSON.stringify(input.models);

    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const checkStmt = this.#db.prepare("SELECT 1 FROM projects WHERE id = ? LIMIT 1");
      let id = base;
      let suffix = 2;
      while (checkStmt.get(id) !== undefined) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }

      this.#db
        .prepare(
          `INSERT INTO projects (id, title, workspaces_json, memory, models_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, title, workspacesJson, memory, modelsJson, now, now);

      this.#db.exec("COMMIT;");
      return {
        id,
        title,
        workspaces,
        ...(memory === null ? {} : { memory }),
        ...(input.models === undefined ? {} : { models: input.models }),
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK;");
      throw error;
    }
  }

  listProjects(): ProjectSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT id, title, workspaces_json, memory, models_json, created_at, updated_at
         FROM projects
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  getProject(id: string): ProjectSummary | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, title, workspaces_json, memory, models_json, created_at, updated_at
         FROM projects
         WHERE id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : rowToProject(row);
  }

  updateProject(id: string, patch: UpdateProjectInput): ProjectSummary | undefined {
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.getProject(id);
      if (existing === undefined) {
        this.#db.exec("ROLLBACK;");
        return undefined;
      }

      const nextTitle =
        patch.title !== undefined
          ? (() => {
              const trimmed = patch.title.trim();
              if (trimmed.length === 0) throw new Error("Project title cannot be empty");
              return trimmed;
            })()
          : existing.title;
      const nextWorkspaces =
        patch.workspaces !== undefined
          ? normalizeWorkspaces(patch.workspaces)
          : existing.workspaces;
      const nextMemory =
        patch.memory === null
          ? null
          : patch.memory !== undefined
            ? patch.memory
            : (existing.memory ?? null);
      const nextModels =
        patch.models === null
          ? undefined
          : patch.models !== undefined
            ? patch.models
            : existing.models;
      const updatedAt = Date.now();

      this.#db
        .prepare(
          `UPDATE projects
           SET title = ?, workspaces_json = ?, memory = ?, models_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextTitle,
          JSON.stringify(nextWorkspaces),
          nextMemory,
          nextModels === undefined ? null : JSON.stringify(nextModels),
          updatedAt,
          id,
        );

      this.#db.exec("COMMIT;");
      return {
        id,
        title: nextTitle,
        workspaces: nextWorkspaces,
        ...(nextMemory === null ? {} : { memory: nextMemory }),
        ...(nextModels === undefined ? {} : { models: nextModels }),
        createdAt: existing.createdAt,
        updatedAt,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK;");
      throw error;
    }
  }

  deleteProject(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  getKv<T = unknown>(key: string): T | undefined {
    const row = this.#db.prepare("SELECT value_json FROM kv WHERE key = ?").get(key) as
      | KvRow
      | undefined;
    if (row === undefined) return undefined;
    return JSON.parse(row.value_json) as T;
  }

  setKv(key: string, value: unknown): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO kv (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now);
  }

  deleteKv(key: string): boolean {
    const result = this.#db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    return Number(result.changes) > 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
