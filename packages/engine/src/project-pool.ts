import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { CommitObservation, Report, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createMcpHub,
  type McpHub,
  type McpHubOptions,
  type McpOAuthCredentialStore,
  type McpServerEntry,
  mcpOAuthStoreKey,
} from "@eevee/agent";
import { type BoardView, openProject as openCoreProject, type ProjectHandle } from "@eevee/core";
import type { ProjectSummary } from "@eevee/protocol";
import { type DataDirLayout, projectPaths } from "./data-dir.ts";
import {
  type EngineKnobs,
  effectiveSkillsPolicy,
  formatModelProfiles,
  hasProjectMcpOverrides,
  MAX_HIBERNATE_SWEEP_MS,
  MIN_HIBERNATE_SWEEP_MS,
  readModelProfiles,
  resolveEffectiveProjectMcpForStore,
} from "./engine-config.ts";
import { EngineError } from "./engine-error.ts";
import { KeyedSerialQueue } from "./serial-queue.ts";
import type { EngineStore } from "./store.ts";

export type PoolBoardEvent =
  | { readonly type: "board"; readonly projectId: string; readonly board: BoardView }
  | { readonly type: "removed"; readonly projectId: string };

const EMPTY_BOARD: BoardView = { workers: [], tickets: [], questions: [] };

export type OpenProjectStorage = (
  sessionDbPath: string,
  project: ProjectSummary,
) => Promise<Storage>;

export type ProjectPoolDeps = {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly models: () => Models;
  readonly knobs: EngineKnobs;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHomeDir?: string | null;
  readonly createMcpTransport?: McpHubOptions["createTransport"];
  readonly openProjectStorage?: OpenProjectStorage;
  readonly onReport?: (projectId: string, report: Report) => void;
  readonly onPumpError?: (projectId: string, error: unknown) => void;
};

type OpenProjectEntry = {
  readonly handle: ProjectHandle;
  readonly observation: CommitObservation;
  projectMcpHub?: McpHub;
  lastActivityAt: number;
};

export class ProjectPool {
  readonly #deps: ProjectPoolDeps;
  readonly #projects = new Map<string, OpenProjectEntry>();
  readonly #opening = new Map<string, Promise<ProjectHandle>>();
  readonly #closingProjects = new Map<string, Promise<void>>();
  readonly #mcpQueue = new KeyedSerialQueue();
  readonly #deletingProjects = new Set<string>();
  readonly #streamCounts = new Map<string, number>();
  readonly #boardListeners = new Set<(event: PoolBoardEvent) => void>();
  readonly #boardCache = new Map<
    string,
    { readonly board: BoardView; readonly signature: string }
  >();
  readonly #boardUnsubs = new Map<string, () => void>();
  #hibernateTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(deps: ProjectPoolDeps) {
    this.#deps = deps;
    this.#rescheduleHibernateSweeper();
  }

  getCachedBoard(projectId: string): BoardView | undefined {
    return this.#boardCache.get(projectId)?.board;
  }

  cacheBoard(projectId: string, board: BoardView): void {
    if (this.#closed || this.#deletingProjects.has(projectId)) return;
    this.#recordAndEmitBoard(projectId, board);
  }

  notifyProjectCreated(projectId: string): void {
    if (this.#closed || this.#deletingProjects.has(projectId)) return;
    this.#recordAndEmitBoard(projectId, EMPTY_BOARD);
  }

  subscribeBoardEvents(listener: (event: PoolBoardEvent) => void): () => void {
    if (this.#closed) return () => {};
    this.#boardListeners.add(listener);
    if (this.#boardListeners.size === 1) {
      for (const [projectId, entry] of this.#projects) {
        this.#attachBoardFeed(projectId, entry.handle);
      }
    }
    return () => {
      this.#boardListeners.delete(listener);
      if (this.#boardListeners.size === 0) {
        for (const unsub of this.#boardUnsubs.values()) {
          unsub();
        }
        this.#boardUnsubs.clear();
      }
    };
  }

  isProjectOpen(projectId: string): boolean {
    return this.#projects.has(projectId);
  }

  isDeleting(projectId: string): boolean {
    return this.#deletingProjects.has(projectId);
  }

  getOpenHandle(projectId: string): ProjectHandle | undefined {
    return this.#projects.get(projectId)?.handle;
  }

  getProjectMcpHub(projectId: string): McpHub | undefined {
    const openEntry = this.#projects.get(projectId);
    if (openEntry !== undefined) {
      return openEntry.projectMcpHub ?? this.#deps.mcpHub;
    }
    if (!hasProjectMcpOverrides(this.#deps.store, projectId)) {
      return this.#deps.mcpHub;
    }
    return undefined;
  }

  async openProjectMcpHub(projectId: string): Promise<McpHub> {
    await this.openProject(projectId);
    return this.getProjectMcpHub(projectId) ?? this.#deps.mcpHub;
  }

  touch(projectId: string): void {
    const entry = this.#projects.get(projectId);
    if (entry !== undefined) entry.lastActivityAt = Date.now();
  }

  acquireStream(projectId: string): () => void {
    this.#streamCounts.set(projectId, (this.#streamCounts.get(projectId) ?? 0) + 1);
    this.touch(projectId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.#streamCounts.get(projectId) ?? 0) - 1;
      if (next <= 0) this.#streamCounts.delete(projectId);
      else this.#streamCounts.set(projectId, next);
      this.touch(projectId);
    };
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
    if (this.#deletingProjects.has(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) {
      existing.lastActivityAt = Date.now();
      return existing.handle;
    }

    const inFlight = this.#opening.get(projectId);
    if (inFlight !== undefined) return inFlight;

    const project = this.#requireProject(projectId);
    const opening = (async () => {
      const closing = this.#closingProjects.get(projectId);
      if (closing !== undefined) await closing.catch(() => undefined);
      if (this.#closed) {
        throw new EngineError(503, "engine_closed", "Engine is closing");
      }
      if (this.#deletingProjects.has(projectId)) {
        throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
      }
      const existingAfterClose = this.#projects.get(projectId);
      if (existingAfterClose !== undefined) {
        existingAfterClose.lastActivityAt = Date.now();
        return existingAfterClose.handle;
      }
      return this.#openProjectNow(this.#requireProject(projectId) ?? project);
    })().finally(() => {
      this.#opening.delete(projectId);
    });
    this.#opening.set(projectId, opening);
    return opening;
  }

  async deleteOpenProject(
    projectId: string,
    remove: () => Promise<void>,
    beforeClose?: () => Promise<void>,
  ): Promise<void> {
    if (this.#deletingProjects.has(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    this.#deletingProjects.add(projectId);
    try {
      await beforeClose?.();
      const opening = this.#opening.get(projectId);
      if (opening !== undefined) await opening.catch(() => undefined);
      const closing = this.#closingProjects.get(projectId);
      if (closing !== undefined) await closing.catch(() => undefined);
      if (this.#projects.has(projectId)) {
        await this.#closeOpenProject(projectId);
      }
      await remove();
      this.#emitProjectRemoved(projectId);
    } finally {
      this.#deletingProjects.delete(projectId);
    }
  }

  async recoverProjects(): Promise<void> {
    const projectIds = this.#deps.store.listProjectIds();
    if (projectIds.length === 0) return;
    const errors: unknown[] = [];
    const concurrency = Math.min(4, projectIds.length);
    let index = 0;

    const worker = async (): Promise<void> => {
      while (!this.#closed) {
        const current = index;
        index += 1;
        const projectId = projectIds[current];
        if (projectId === undefined) return;
        try {
          await this.openProject(projectId);
        } catch (error) {
          errors.push(error);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to recover ${errors.length} project(s)`);
    }
  }

  async hibernateIdleProjects(now = Date.now()): Promise<string[]> {
    if (this.#closed) return [];
    const idleMs = this.#deps.knobs.idleHibernateMs();
    if (idleMs <= 0) return [];

    const candidates = [...this.#projects.entries()];
    const hibernated: string[] = [];

    for (const [projectId, entry] of candidates) {
      if (this.#closed) break;
      if ((this.#streamCounts.get(projectId) ?? 0) > 0) continue;
      if (now - entry.lastActivityAt < idleMs) continue;
      if (entry.handle.harness.wake().active) continue;

      let inspection: Awaited<ReturnType<ProjectHandle["harness"]["inspect"]>>;
      try {
        inspection = await entry.handle.harness.inspect(BACKGROUND_CONTEXT);
      } catch {
        continue;
      }
      if (inspection.tasks.length > 0 || inspection.submissions.length > 0) continue;

      if (this.#closed || this.#projects.get(projectId) !== entry) continue;
      if ((this.#streamCounts.get(projectId) ?? 0) > 0) continue;
      if (now - entry.lastActivityAt < idleMs) continue;
      if (entry.handle.harness.wake().active) continue;

      try {
        const board = await entry.handle.board(BACKGROUND_CONTEXT);
        if (!this.#closed && this.#projects.get(projectId) === entry) {
          this.#recordAndEmitBoard(projectId, board);
        }
      } catch {}

      if (this.#closed || this.#projects.get(projectId) !== entry) continue;
      if ((this.#streamCounts.get(projectId) ?? 0) > 0) continue;
      if (now - entry.lastActivityAt < idleMs) continue;
      if (entry.handle.harness.wake().active) continue;

      await this.#closeOpenProject(projectId);
      hibernated.push(projectId);
    }

    return hibernated;
  }

  async syncMcpExtensions(): Promise<void> {
    await Promise.all(
      [...this.#projects.values()].map((entry) => entry.handle.syncMcpExtensions()),
    );
  }

  async reloadGlobalMcpChanges(): Promise<void> {
    const projectIds = [...new Set([...this.#projects.keys(), ...this.#opening.keys()])];
    await Promise.all(projectIds.map((projectId) => this.syncProjectMcp(projectId)));
  }

  async syncProjectMcp(projectId: string): Promise<void> {
    await this.#mcpQueue.enqueue(projectId, () => this.#syncProjectMcpNow(projectId));
  }

  async syncProjectMcpUnlocked(projectId: string): Promise<void> {
    await this.#syncProjectMcpNow(projectId);
  }

  async runProjectMcpMutation<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
    this.#requireProject(projectId);
    return this.#mcpQueue.enqueue(projectId, async () => {
      if (this.#closed) {
        throw new EngineError(503, "engine_closed", "Engine is closing");
      }
      this.#requireProject(projectId);
      return fn();
    });
  }

  async updateProjectMcpRoots(projectId: string, workspaces: readonly string[]): Promise<void> {
    await this.#mcpQueue.enqueue(projectId, async () => {
      if (this.#closed || this.#deletingProjects.has(projectId)) return;
      const entry = this.#projects.get(projectId);
      if (entry?.projectMcpHub !== undefined) {
        await entry.projectMcpHub.updateRoots(workspaces);
      }
    });
  }

  async reconnectServerOnProject(projectId: string, serverName: string): Promise<void> {
    await this.#mcpQueue.enqueue(projectId, async () => {
      if (this.#closed || this.#deletingProjects.has(projectId)) return;
      const opening = this.#opening.get(projectId);
      if (opening !== undefined) {
        await opening.catch(() => undefined);
      }
      if (this.#closed || this.#deletingProjects.has(projectId)) return;
      const entry = this.#projects.get(projectId);
      if (entry?.projectMcpHub?.status().some((snap) => snap.name === serverName && snap.enabled)) {
        await entry.projectMcpHub.reconnect(serverName).catch(() => undefined);
        await entry.handle.syncMcpExtensions();
      }
    });
  }

  async reconnectServerOnProjectHubs(
    serverName: string,
    storeKey?: string,
    excludeProjectId?: string,
  ): Promise<void> {
    const projectIds = [...new Set([...this.#projects.keys(), ...this.#opening.keys()])].filter(
      (id) => id !== excludeProjectId,
    );
    await Promise.all(
      projectIds.map((projectId) =>
        this.#mcpQueue.enqueue(projectId, async () => {
          if (this.#closed || this.#deletingProjects.has(projectId)) return;
          const opening = this.#opening.get(projectId);
          if (opening !== undefined) {
            await opening.catch(() => undefined);
          }
          if (this.#closed || this.#deletingProjects.has(projectId)) return;
          const entry = this.#projects.get(projectId);
          if (
            entry?.projectMcpHub?.status().some((snap) => snap.name === serverName && snap.enabled)
          ) {
            if (storeKey !== undefined) {
              const effective = resolveEffectiveProjectMcpForStore(this.#deps.store, projectId);
              const server = effective.find((item) => item.name === serverName);
              if (
                server === undefined ||
                !("url" in server.config) ||
                mcpOAuthStoreKey(serverName, server.config.url) !== storeKey
              ) {
                return;
              }
            }
            await entry.projectMcpHub.reconnect(serverName).catch(() => undefined);
            await entry.handle.syncMcpExtensions();
          }
        }),
      ),
    );
  }

  async applySettingsLive(): Promise<void> {
    this.#rescheduleHibernateSweeper();
    await Promise.all(
      [...this.#projects.entries()].map(async ([projectId, entry]) => {
        await entry.handle.reconfigureRouterModel(this.#deps.knobs.modelSlots(projectId).router);
        await entry.handle.reconfigureTools();
        entry.handle.requestPump();
      }),
    );
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    for (const unsub of this.#boardUnsubs.values()) {
      unsub();
    }
    this.#boardUnsubs.clear();
    this.#boardListeners.clear();
    this.#boardCache.clear();
    if (this.#hibernateTimer !== undefined) {
      clearInterval(this.#hibernateTimer);
      this.#hibernateTimer = undefined;
    }
    await Promise.allSettled([...this.#opening.values()]);
    await Promise.allSettled([...this.#closingProjects.values()]);
    await this.#mcpQueue.drainAll();
    const entries = [...this.#projects.entries()];
    this.#projects.clear();
    await Promise.allSettled(
      entries.map(async ([, entry]) => {
        entry.observation.detach();
        try {
          await entry.handle.close();
        } finally {
          await entry.projectMcpHub?.close().catch(() => undefined);
        }
      }),
    );
  }

  async #syncProjectMcpNow(projectId: string): Promise<void> {
    if (this.#closed || this.#deletingProjects.has(projectId)) return;
    const opening = this.#opening.get(projectId);
    if (opening !== undefined) {
      await opening.catch(() => undefined);
    }
    if (this.#closed || this.#deletingProjects.has(projectId)) return;
    const entry = this.#projects.get(projectId);
    if (entry === undefined) return;

    const hasOverrides = hasProjectMcpOverrides(this.#deps.store, projectId);
    if (!hasOverrides) {
      if (entry.projectMcpHub !== undefined) {
        const oldHub = entry.projectMcpHub;
        entry.projectMcpHub = undefined;
        try {
          await entry.handle.rebindMcpHub(this.#deps.mcpHub);
        } finally {
          await oldHub.close().catch(() => undefined);
        }
      } else {
        await entry.handle.syncMcpExtensions();
      }
      return;
    }

    const servers = resolveEffectiveProjectMcpForStore(this.#deps.store, projectId);
    if (entry.projectMcpHub !== undefined) {
      await entry.projectMcpHub.reload(servers);
      await entry.handle.syncMcpExtensions();
      return;
    }

    const project = this.#requireProject(projectId);
    const nextHub = this.#createProjectMcpHub(project, servers);
    try {
      await nextHub.start();
      if (
        this.#closed ||
        this.#deletingProjects.has(projectId) ||
        this.#projects.get(projectId) !== entry
      ) {
        await nextHub.close().catch(() => undefined);
        return;
      }
      entry.projectMcpHub = nextHub;
      await entry.handle.rebindMcpHub(nextHub);
    } catch (error) {
      if (entry.projectMcpHub === nextHub) {
        entry.projectMcpHub = undefined;
      }
      await nextHub.close().catch(() => undefined);
      throw error;
    }
  }

  #createProjectMcpHub(project: ProjectSummary, servers: readonly McpServerEntry[]): McpHub {
    const paths = projectPaths(this.#deps.layout, project.id);
    return createMcpHub({
      servers,
      cwd: project.workspaces[0],
      env: this.#deps.env,
      roots: () => this.#deps.store.getProject(project.id)?.workspaces ?? project.workspaces,
      oauthStore: this.#deps.oauthStore,
      logPath: join(paths.logsDir, "mcp.log"),
      ...(this.#deps.createMcpTransport === undefined
        ? {}
        : { createTransport: this.#deps.createMcpTransport }),
    });
  }

  #requireProject(projectId: string): ProjectSummary {
    if (this.#deletingProjects.has(projectId)) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    const project = this.#deps.store.getProject(projectId);
    if (project === undefined) {
      throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
    }
    return project;
  }

  #rescheduleHibernateSweeper(): void {
    if (this.#hibernateTimer !== undefined) {
      clearInterval(this.#hibernateTimer);
      this.#hibernateTimer = undefined;
    }
    if (this.#closed) return;
    const idleMs = this.#deps.knobs.idleHibernateMs();
    if (idleMs <= 0) return;
    const intervalMs = Math.max(MIN_HIBERNATE_SWEEP_MS, Math.min(idleMs, MAX_HIBERNATE_SWEEP_MS));
    this.#hibernateTimer = setInterval(() => {
      void this.hibernateIdleProjects();
    }, intervalMs);
    this.#hibernateTimer.unref?.();
  }

  async #closeOpenProject(projectId: string): Promise<void> {
    this.#boardUnsubs.get(projectId)?.();
    this.#boardUnsubs.delete(projectId);
    const entry = this.#projects.get(projectId);
    if (entry === undefined) {
      const existingClosing = this.#closingProjects.get(projectId);
      if (existingClosing !== undefined) await existingClosing;
      await this.#mcpQueue.drain(projectId);
      return;
    }
    this.#projects.delete(projectId);
    entry.observation.detach();
    const closing = (async () => {
      await this.#mcpQueue.drain(projectId);
      try {
        await entry.handle.close();
      } finally {
        await entry.projectMcpHub?.close().catch(() => undefined);
      }
    })().finally(() => {
      if (this.#closingProjects.get(projectId) === closing) {
        this.#closingProjects.delete(projectId);
      }
    });
    this.#closingProjects.set(projectId, closing);
    await closing;
  }

  async #openProjectNow(project: ProjectSummary): Promise<ProjectHandle> {
    const { layout, store, mcpHub, knobs } = this.#deps;
    const paths = projectPaths(layout, project.id);
    await mkdir(paths.dir, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });

    const openStorage: OpenProjectStorage =
      this.#deps.openProjectStorage ?? ((sessionDbPath) => openNodeSqliteStorage(sessionDbPath));

    const storage = await openStorage(paths.sessionDb, project);
    const primaryWorkspace = project.workspaces[0];
    if (primaryWorkspace === undefined) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
      throw new EngineError(500, "invalid_project", `Project ${project.id} has no workspaces`);
    }

    let projectMcpHub: McpHub | undefined;
    try {
      if (hasProjectMcpOverrides(store, project.id)) {
        const servers = resolveEffectiveProjectMcpForStore(store, project.id);
        projectMcpHub = this.#createProjectMcpHub(project, servers);
        projectMcpHub.startBackground();
      }

      const handle = await openCoreProject(storage, {
        cwd: primaryWorkspace,
        title: project.title,
        workspaces: project.workspaces,
        models: () => this.#deps.models(),
        modelSlots: () => knobs.modelSlots(project.id),
        mcpHub: projectMcpHub ?? mcpHub,
        baseExtensionOptions: {
          globalDir: layout.root,
          ...(this.#deps.userHomeDir === undefined ? {} : { userHomeDir: this.#deps.userHomeDir }),
          skillPolicy: () => effectiveSkillsPolicy(store, project.id),
        },
        projectMeta: () => {
          const current = store.getProject(project.id) ?? project;
          return { title: current.title, workspaces: current.workspaces };
        },
        projectMemory: () => store.getProject(project.id)?.memory,
        modelProfiles: () => formatModelProfiles(readModelProfiles(store)),
        maxActiveWorkers: () => knobs.maxActiveWorkers(),
        backgroundAfterMs: () => knobs.backgroundAfterMs(),
        routerContextTokens: () => knobs.routerContextTokens(),
        toolPolicy: () => knobs.toolPolicy(project.id),
        taskLogPath: (conversationId, taskId) =>
          join(paths.logsDir, `${conversationId}-${taskId}.log`),
        ...(this.#deps.onReport === undefined
          ? {}
          : { onReport: (report) => this.#deps.onReport?.(project.id, report) }),
        ...(this.#deps.onPumpError === undefined
          ? {}
          : { onPumpError: (error) => this.#deps.onPumpError?.(project.id, error) }),
      });

      if (this.#closed || this.#deletingProjects.has(project.id)) {
        await handle.close().catch(() => undefined);
        await projectMcpHub?.close().catch(() => undefined);
        throw new EngineError(
          this.#closed ? 503 : 404,
          this.#closed ? "engine_closed" : "project_not_found",
          this.#closed ? "Engine is closing" : `Unknown project ${project.id}`,
        );
      }

      let entryRef: OpenProjectEntry | undefined;
      const observation = handle.harness.observeCommits({
        advance: () => {
          if (entryRef !== undefined) entryRef.lastActivityAt = Date.now();
        },
        end: () => {},
      });
      const entry: OpenProjectEntry = {
        handle,
        observation,
        ...(projectMcpHub === undefined ? {} : { projectMcpHub }),
        lastActivityAt: Date.now(),
      };
      entryRef = entry;
      this.#projects.set(project.id, entry);
      if (this.#boardListeners.size > 0) {
        this.#attachBoardFeed(project.id, handle);
      }
      return handle;
    } catch (error) {
      await projectMcpHub?.close().catch(() => undefined);
      await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
      throw error;
    }
  }

  #attachBoardFeed(projectId: string, handle: ProjectHandle): void {
    if (
      this.#closed ||
      this.#deletingProjects.has(projectId) ||
      this.#boardListeners.size === 0 ||
      this.#boardUnsubs.has(projectId)
    ) {
      return;
    }
    let primed = false;
    const unsub = handle.subscribeBoard((board) => {
      if (!primed || this.#closed || this.#deletingProjects.has(projectId)) return;
      this.#recordAndEmitBoard(projectId, board);
    });
    primed = true;
    this.#boardUnsubs.set(projectId, unsub);
  }

  #recordAndEmitBoard(projectId: string, board: BoardView): void {
    const signature = JSON.stringify(board);
    const cached = this.#boardCache.get(projectId);
    if (cached !== undefined && cached.signature === signature) return;
    this.#boardCache.set(projectId, { board, signature });
    for (const listener of [...this.#boardListeners]) {
      try {
        listener({ type: "board", projectId, board });
      } catch {}
    }
  }

  #emitProjectRemoved(projectId: string): void {
    this.#boardCache.delete(projectId);
    for (const listener of [...this.#boardListeners]) {
      try {
        listener({ type: "removed", projectId });
      } catch {}
    }
  }
}
