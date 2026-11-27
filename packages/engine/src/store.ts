import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { arr, map, type Schema, type Static, str } from "@earendil-works/pi-schema";
import {
  type CreateProjectRequest,
  type McpServerEntryInput,
  McpServerEntryInputSchema,
  type ModelChoice,
  type ModelSlotsOverride,
  ModelSlotsOverrideSchema,
  type ProjectSummary,
  parseWithSchema,
  type SkillPolicyMap,
  SkillPolicyMapSchema,
  type ToolsSettings,
  ToolsSettingsSchema,
} from "@eevee/protocol";
import { StoreValidationError } from "./engine-error.ts";

export type UpdateProjectInput = {
  readonly title?: string;
  readonly workspaces?: readonly string[];
  readonly memory?: string | null;
  readonly models?: ModelSlotsOverride | null;
  readonly tools?: ToolsSettings | null;
  readonly merge?: boolean;
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

type KvCacheEntry =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly raw: string;
      readonly parsed: WeakMap<Schema, unknown>;
    };

export type ProjectMcpEntry = {
  readonly id: string;
  readonly servers: Record<string, McpServerEntryInput> | undefined;
};

const ProjectWorkspacesSchema = arr(str({ minLength: 1 }), { minItems: 1 });
const McpServersMapSchema = map(McpServerEntryInputSchema);

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

export function mergeModelSlots(
  base: ModelSlotsOverride | undefined,
  patch: ModelSlotsOverride | undefined,
): ModelSlotsOverride | undefined {
  if (patch === undefined) return base;
  const router = patch.router ?? base?.router;
  const worker = patch.worker ?? base?.worker;
  const dreamer = patch.dreamer ?? base?.dreamer;
  return {
    ...(router === undefined ? {} : { router }),
    ...(worker === undefined ? {} : { worker }),
    ...(dreamer === undefined ? {} : { dreamer }),
  };
}

function mergeBoolRecord(
  base: Readonly<Record<string, boolean>> | undefined,
  patch: Readonly<Record<string, boolean>> | undefined,
): Record<string, boolean> | undefined {
  if (base === undefined && patch === undefined) return undefined;
  const merged: Record<string, boolean> = { ...base };
  if (patch !== undefined) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

export function mergeToolsSettings(
  base: ToolsSettings | undefined,
  patch: ToolsSettings | undefined,
): ToolsSettings | undefined {
  if (patch === undefined) return base;
  const router = mergeBoolRecord(base?.router, patch.router);
  const worker = mergeBoolRecord(base?.worker, patch.worker);
  const codemodeMode = patch.codemode?.mode ?? base?.codemode?.mode;
  const codemodeInlineBudget = patch.codemode?.inlineBudget ?? base?.codemode?.inlineBudget;
  const codemode =
    base?.codemode === undefined && patch.codemode === undefined
      ? undefined
      : {
          ...(codemodeMode === undefined ? {} : { mode: codemodeMode }),
          ...(codemodeInlineBudget === undefined ? {} : { inlineBudget: codemodeInlineBudget }),
        };
  return {
    ...(router === undefined ? {} : { router }),
    ...(worker === undefined ? {} : { worker }),
    ...(codemode === undefined ? {} : { codemode }),
  };
}

function cloneModelChoice(choice: ModelChoice): ModelChoice {
  return {
    provider: choice.provider,
    modelId: choice.modelId,
    ...(choice.thinkingLevel === undefined ? {} : { thinkingLevel: choice.thinkingLevel }),
  };
}

function cloneModelSlots(models: ModelSlotsOverride): ModelSlotsOverride {
  return {
    ...(models.router === undefined ? {} : { router: cloneModelChoice(models.router) }),
    ...(models.worker === undefined ? {} : { worker: cloneModelChoice(models.worker) }),
    ...(models.dreamer === undefined ? {} : { dreamer: cloneModelChoice(models.dreamer) }),
  };
}

function cloneToolsSettings(tools: ToolsSettings): ToolsSettings {
  const router = tools.router === undefined ? undefined : { ...tools.router };
  const worker = tools.worker === undefined ? undefined : { ...tools.worker };
  const codemode =
    tools.codemode === undefined
      ? undefined
      : {
          ...(tools.codemode.mode === undefined ? {} : { mode: tools.codemode.mode }),
          ...(tools.codemode.inlineBudget === undefined
            ? {}
            : { inlineBudget: tools.codemode.inlineBudget }),
        };
  return {
    ...(router === undefined ? {} : { router }),
    ...(worker === undefined ? {} : { worker }),
    ...(codemode === undefined ? {} : { codemode }),
  };
}

function cloneProject(project: ProjectSummary): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    workspaces: [...project.workspaces],
    ...(project.memory === undefined ? {} : { memory: project.memory }),
    ...(project.models === undefined ? {} : { models: cloneModelSlots(project.models) }),
    ...(project.tools === undefined ? {} : { tools: cloneToolsSettings(project.tools) }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

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
    throw new StoreValidationError("Project requires at least one workspace");
  }
  const resolved: string[] = [];
  for (const workspace of workspaces) {
    const trimmed = workspace.trim();
    if (trimmed.length === 0) {
      throw new StoreValidationError("Workspace path cannot be empty");
    }
    resolved.push(resolve(trimmed));
  }
  return resolved;
}

export class EngineStore {
  readonly #db: DatabaseSync;
  readonly #kvCache = new Map<string, KvCacheEntry>();
  readonly #projectCache = new Map<string, ProjectSummary>();
  #projectsListCache: readonly ProjectSummary[] | undefined;
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
      this.#invalidateAllCaches();
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

  #invalidateAllCaches(): void {
    this.#kvCache.clear();
    this.#projectCache.clear();
    this.#projectsListCache = undefined;
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
      throw new StoreValidationError("Project requires at least one workspace");
    }
    const title = input.title?.trim() || basename(firstWorkspace) || firstWorkspace;
    const base = baseSlug(title);
    const now = Date.now();
    const workspacesJson = JSON.stringify(workspaces);
    const memory = input.memory ?? null;
    const normalizedModels = input.models === undefined ? undefined : cloneModelSlots(input.models);
    const normalizedTools = input.tools === undefined ? undefined : cloneToolsSettings(input.tools);
    const modelsJson = normalizedModels === undefined ? null : JSON.stringify(normalizedModels);
    const toolsJson = normalizedTools === undefined ? null : JSON.stringify(normalizedTools);

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

      const created: ProjectSummary = {
        id,
        title,
        workspaces,
        ...(memory === null ? {} : { memory }),
        ...(normalizedModels === undefined ? {} : { models: normalizedModels }),
        ...(normalizedTools === undefined ? {} : { tools: normalizedTools }),
        createdAt: now,
        updatedAt: now,
      };
      this.#projectCache.set(id, created);
      this.#projectsListCache = undefined;
      return cloneProject(created);
    });
  }

  listProjectIds(): string[] {
    if (this.#projectsListCache !== undefined) {
      return this.#projectsListCache.map((project) => project.id);
    }
    const rows = this.#db
      .prepare("SELECT id FROM projects ORDER BY created_at ASC, id ASC")
      .all() as { readonly id: string }[];
    return rows.map((row) => row.id);
  }

  listProjectMcpEntries(): ProjectMcpEntry[] {
    const rows = this.#db
      .prepare("SELECT id, mcp_json FROM projects ORDER BY created_at ASC, id ASC")
      .all() as { readonly id: string; readonly mcp_json: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      servers:
        row.mcp_json === null
          ? undefined
          : parseJsonColumn(row.mcp_json, McpServersMapSchema, `project "${row.id}" mcp_json`),
    }));
  }

  listProjects(): ProjectSummary[] {
    if (this.#projectsListCache !== undefined) {
      return this.#projectsListCache.map(cloneProject);
    }
    const rows = this.#db
      .prepare(
        `SELECT id, title, workspaces_json, memory, models_json, tools_json, created_at, updated_at
         FROM projects
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as ProjectRow[];
    const projects = rows.map(rowToProject);
    this.#projectsListCache = projects;
    this.#projectCache.clear();
    for (const project of projects) {
      this.#projectCache.set(project.id, project);
    }
    return projects.map(cloneProject);
  }

  getProject(id: string): ProjectSummary | undefined {
    const cached = this.#projectCache.get(id);
    if (cached !== undefined) return cloneProject(cached);
    if (this.#projectsListCache !== undefined) return undefined;
    const row = this.#db
      .prepare(
        `SELECT id, title, workspaces_json, memory, models_json, tools_json, created_at, updated_at
         FROM projects
         WHERE id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    if (row === undefined) return undefined;
    const project = rowToProject(row);
    this.#projectCache.set(id, project);
    return cloneProject(project);
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
              if (trimmed.length === 0) {
                throw new StoreValidationError("Project title cannot be empty");
              }
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
      const merge = patch.merge === true;
      const mergedModels =
        patch.models === null
          ? undefined
          : patch.models !== undefined
            ? merge
              ? mergeModelSlots(existing.models, patch.models)
              : patch.models
            : existing.models;
      const mergedTools =
        patch.tools === null
          ? undefined
          : patch.tools !== undefined
            ? merge
              ? mergeToolsSettings(existing.tools, patch.tools)
              : patch.tools
            : existing.tools;
      const nextModels = mergedModels === undefined ? undefined : cloneModelSlots(mergedModels);
      const nextTools = mergedTools === undefined ? undefined : cloneToolsSettings(mergedTools);
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

      const updated: ProjectSummary = {
        id,
        title: nextTitle,
        workspaces: nextWorkspaces,
        ...(nextMemory === null ? {} : { memory: nextMemory }),
        ...(nextModels === undefined ? {} : { models: nextModels }),
        ...(nextTools === undefined ? {} : { tools: nextTools }),
        createdAt: existing.createdAt,
        updatedAt,
      };
      this.#projectCache.set(id, updated);
      this.#projectsListCache = undefined;
      return cloneProject(updated);
    });
  }

  deleteProject(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    this.#projectCache.delete(id);
    this.#projectsListCache = undefined;
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
    this.#projectCache.delete(projectId);
    this.#projectsListCache = undefined;
    return Number(result.changes) > 0;
  }

  getProjectMcpServers(projectId: string): Record<string, McpServerEntryInput> | undefined {
    const row = this.#db.prepare("SELECT mcp_json FROM projects WHERE id = ?").get(projectId) as
      | { readonly mcp_json: string | null }
      | undefined;
    if (row === undefined || row.mcp_json === null) return undefined;
    return parseJsonColumn(row.mcp_json, McpServersMapSchema, `project "${projectId}" mcp_json`);
  }

  setProjectMcpServers(
    projectId: string,
    servers: Record<string, McpServerEntryInput> | null,
  ): boolean {
    const json =
      servers === null || Object.keys(servers).length === 0 ? null : JSON.stringify(servers);
    const result = this.#db
      .prepare("UPDATE projects SET mcp_json = ?, updated_at = ? WHERE id = ?")
      .run(json, Date.now(), projectId);
    this.#projectCache.delete(projectId);
    this.#projectsListCache = undefined;
    return Number(result.changes) > 0;
  }

  hasKv(key: string): boolean {
    const cached = this.#kvCache.get(key);
    if (cached !== undefined) return cached.present;
    const row = this.#db.prepare("SELECT value_json FROM kv WHERE key = ?").get(key) as
      | KvRow
      | undefined;
    if (row === undefined) {
      this.#kvCache.set(key, { present: false });
      return false;
    }
    this.#kvCache.set(key, { present: true, raw: row.value_json, parsed: new WeakMap() });
    return true;
  }

  getKvParsed<S extends Schema>(key: string, schema: S): Static<S> | undefined {
    const cached = this.#kvCache.get(key);
    if (cached !== undefined) {
      if (!cached.present) return undefined;
      if (cached.parsed.has(schema)) {
        return structuredClone(cached.parsed.get(schema)) as Static<S>;
      }
      const parsed = parseJsonColumn(cached.raw, schema, `stored kv "${key}"`);
      cached.parsed.set(schema, parsed);
      return structuredClone(parsed);
    }
    const row = this.#db.prepare("SELECT value_json FROM kv WHERE key = ?").get(key) as
      | KvRow
      | undefined;
    if (row === undefined) {
      this.#kvCache.set(key, { present: false });
      return undefined;
    }
    const parsed = parseJsonColumn(row.value_json, schema, `stored kv "${key}"`);
    const bySchema = new WeakMap<Schema, unknown>();
    bySchema.set(schema, parsed);
    this.#kvCache.set(key, { present: true, raw: row.value_json, parsed: bySchema });
    return structuredClone(parsed);
  }

  setKv(key: string, value: unknown): void {
    const now = Date.now();
    this.#kvCache.delete(key);
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
    this.#kvCache.delete(key);
    const result = this.#db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    return Number(result.changes) > 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#invalidateAllCaches();
    this.#db.close();
  }
}
