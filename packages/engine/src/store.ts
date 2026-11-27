import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { arr, map, type Schema, type Static, str } from "@earendil-works/pi-schema";
import {
  type CreateProjectRequest,
  McpServerEntryFieldSchema,
  type ModelSlotsOverride,
  ModelSlotsOverrideSchema,
  type ProjectSummary,
  parseWithSchema,
  type SkillPolicyMap,
  SkillPolicyMapSchema,
  type ToolsSettings,
  ToolsSettingsSchema,
} from "@eevee/protocol";

export type UpdateProjectInput = {
  readonly title?: string;
  readonly workspaces?: readonly string[];
  readonly memory?: string | null;
  readonly models?: ModelSlotsOverride | null;
  readonly tools?: ToolsSettings | null;
};

type ProjectRow = {
  readonly id: string;
  readonly title: string;
  readonly workspaces_json: string;
  readonly memory: string | null;
  readonly models_json: string | null;
  readonly tools_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type KvRow = {
  readonly value_json: string;
};

const ProjectWorkspacesSchema = arr(str({ minLength: 1 }), { minItems: 1 });
const McpServersMapSchema = map(McpServerEntryFieldSchema);

type Migration = (db: DatabaseSync) => void;

const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspaces_json TEXT NOT NULL,
        memory TEXT,
        models_json TEXT,
        tools_json TEXT,
        skills_policy_json TEXT,
        mcp_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(
      (db.prepare("PRAGMA table_info(projects)").all() as { readonly name: string }[]).map(
        (column) => column.name,
      ),
    );
    for (const column of ["tools_json", "skills_policy_json", "mcp_json"]) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`);
      }
    }
  },
];

function parseJsonText(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Corrupt JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonColumn<S extends Schema>(raw: string, schema: S, label: string): Static<S> {
  return parseWithSchema(schema, parseJsonText(raw, label), label);
}

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
  const workspaces = parseJsonColumn(
    row.workspaces_json,
    ProjectWorkspacesSchema,
    `project "${row.id}" workspaces_json`,
  );
  const models =
    row.models_json === null
      ? undefined
      : parseJsonColumn(
          row.models_json,
          ModelSlotsOverrideSchema,
          `project "${row.id}" models_json`,
        );
  const tools =
    row.tools_json === null
      ? undefined
      : parseJsonColumn(row.tools_json, ToolsSettingsSchema, `project "${row.id}" tools_json`);
  return {
    id: row.id,
    title: row.title,
    workspaces,
    ...(row.memory === null ? {} : { memory: row.memory }),
    ...(models === undefined ? {} : { models }),
    ...(tools === undefined ? {} : { tools }),
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
  #transactionDepth = 0;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  transaction<T>(fn: () => T): T {
    const depth = this.#transactionDepth;
    const savepoint = depth > 0 ? `eevee_sp_${depth}` : undefined;
    this.#db.exec(savepoint === undefined ? "BEGIN IMMEDIATE;" : `SAVEPOINT ${savepoint};`);
    this.#transactionDepth = depth + 1;
    try {
      const result = fn();
      this.#db.exec(savepoint === undefined ? "COMMIT;" : `RELEASE SAVEPOINT ${savepoint};`);
      return result;
    } catch (error) {
      try {
        this.#db.exec(
          savepoint === undefined
            ? "ROLLBACK;"
            : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`,
        );
      } catch {
        // Preserve the original failure if SQLite already rolled back the transaction.
      }
      throw error;
    } finally {
      this.#transactionDepth = depth;
    }
  }

  static open(dbPath: string): EngineStore {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      const store = new EngineStore(db);
      store.#migrate();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #readUserVersion(): number {
    const row = this.#db.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    return row?.user_version ?? 0;
  }

  #migrate(): void {
    if (this.#readUserVersion() >= MIGRATIONS.length) return;
    this.transaction(() => {
      const currentVersion = this.#readUserVersion();
      for (let version = currentVersion; version < MIGRATIONS.length; version += 1) {
        MIGRATIONS[version]?.(this.#db);
        this.#db.exec(`PRAGMA user_version = ${version + 1};`);
      }
    });
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
    const toolsJson = input.tools === undefined ? null : JSON.stringify(input.tools);

    return this.transaction(() => {
      const checkStmt = this.#db.prepare("SELECT 1 FROM projects WHERE id = ? LIMIT 1");
      let id = base;
      let suffix = 2;
      while (checkStmt.get(id) !== undefined) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }

      this.#db
        .prepare(
          `INSERT INTO projects (id, title, workspaces_json, memory, models_json, tools_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, title, workspacesJson, memory, modelsJson, toolsJson, now, now);

      return {
        id,
        title,
        workspaces,
        ...(memory === null ? {} : { memory }),
        ...(input.models === undefined ? {} : { models: input.models }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  listProjects(): ProjectSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT id, title, workspaces_json, memory, models_json, tools_json, created_at, updated_at
         FROM projects
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  getProject(id: string): ProjectSummary | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, title, workspaces_json, memory, models_json, tools_json, created_at, updated_at
         FROM projects
         WHERE id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : rowToProject(row);
  }

  updateProject(id: string, patch: UpdateProjectInput): ProjectSummary | undefined {
    return this.transaction(() => {
      const existing = this.getProject(id);
      if (existing === undefined) {
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
      const nextTools =
        patch.tools === null ? undefined : patch.tools !== undefined ? patch.tools : existing.tools;
      const updatedAt = Date.now();

      this.#db
        .prepare(
          `UPDATE projects
           SET title = ?, workspaces_json = ?, memory = ?, models_json = ?, tools_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextTitle,
          JSON.stringify(nextWorkspaces),
          nextMemory,
          nextModels === undefined ? null : JSON.stringify(nextModels),
          nextTools === undefined ? null : JSON.stringify(nextTools),
          updatedAt,
          id,
        );

      return {
        id,
        title: nextTitle,
        workspaces: nextWorkspaces,
        ...(nextMemory === null ? {} : { memory: nextMemory }),
        ...(nextModels === undefined ? {} : { models: nextModels }),
        ...(nextTools === undefined ? {} : { tools: nextTools }),
        createdAt: existing.createdAt,
        updatedAt,
      };
    });
  }

  deleteProject(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  getProjectSkillsPolicy(projectId: string): SkillPolicyMap | undefined {
    const row = this.#db
      .prepare("SELECT skills_policy_json FROM projects WHERE id = ?")
      .get(projectId) as { readonly skills_policy_json: string | null } | undefined;
    if (row === undefined || row.skills_policy_json === null) return undefined;
    return parseJsonColumn(
      row.skills_policy_json,
      SkillPolicyMapSchema,
      `project "${projectId}" skills_policy_json`,
    );
  }

  setProjectSkillsPolicy(projectId: string, policy: SkillPolicyMap | null): boolean {
    const json = policy === null ? null : JSON.stringify(policy);
    const result = this.#db
      .prepare("UPDATE projects SET skills_policy_json = ?, updated_at = ? WHERE id = ?")
      .run(json, Date.now(), projectId);
    return Number(result.changes) > 0;
  }

  getProjectMcpServers(projectId: string): Record<string, Record<string, unknown>> | undefined {
    const row = this.#db.prepare("SELECT mcp_json FROM projects WHERE id = ?").get(projectId) as
      | { readonly mcp_json: string | null }
      | undefined;
    if (row === undefined || row.mcp_json === null) return undefined;
    return parseJsonColumn(
      row.mcp_json,
      McpServersMapSchema,
      `project "${projectId}" mcp_json`,
    ) as Record<string, Record<string, unknown>>;
  }

  setProjectMcpServers(
    projectId: string,
    servers: Record<string, Record<string, unknown>> | null,
  ): boolean {
    const json =
      servers === null || Object.keys(servers).length === 0 ? null : JSON.stringify(servers);
    const result = this.#db
      .prepare("UPDATE projects SET mcp_json = ?, updated_at = ? WHERE id = ?")
      .run(json, Date.now(), projectId);
    return Number(result.changes) > 0;
  }

  getKv<T = unknown>(key: string): T | undefined {
    const row = this.#db.prepare("SELECT value_json FROM kv WHERE key = ?").get(key) as
      | KvRow
      | undefined;
    if (row === undefined) return undefined;
    return parseJsonText(row.value_json, `stored kv "${key}"`) as T;
  }

  getKvParsed<S extends Schema>(key: string, schema: S): Static<S> | undefined {
    const row = this.#db.prepare("SELECT value_json FROM kv WHERE key = ?").get(key) as
      | KvRow
      | undefined;
    if (row === undefined) return undefined;
    return parseJsonColumn(row.value_json, schema, `stored kv "${key}"`);
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
