import type { Models } from "@earendil-works/pi-ai";
import type { McpHub, McpOAuthCredentialStore } from "@eevee/agent";
import type { ModelRuntime } from "@eevee/agent/models";
import type { BoardView, ProjectHandle } from "@eevee/core";
import type { DataDirLayout } from "./data-dir.ts";
import type { SettingsHandle } from "./engine-config.ts";
import {
  disposeEngineContext,
  type EngineContext,
  type EngineLifecycleState,
  type EngineOptions,
  openEngineContext,
} from "./engine-context.ts";
import type { EngineMcpAccessor } from "./engine-mcp.ts";
import type { ProjectsHandle } from "./engine-projects.ts";
import type { ProvidersHandle } from "./engine-providers-manage.ts";
import type { SkillsHandle } from "./engine-skills.ts";
import type { PoolBoardEvent } from "./project-pool.ts";
import type { EngineStore } from "./store.ts";

export { formatModelProfiles, type SettingsHandle } from "./engine-config.ts";
export type { EngineOptions } from "./engine-context.ts";
export { EngineError, StoreValidationError } from "./engine-error.ts";
export type {
  EngineMcpAccessor,
  GlobalMcpHandle,
  ProjectMcpHandle,
  ScopedMcpHandle,
} from "./engine-mcp.ts";
export type { ListEntriesParams, ProjectsHandle } from "./engine-projects.ts";
export type { ProvidersHandle } from "./engine-providers-manage.ts";
export type { SkillsHandle } from "./engine-skills.ts";
export {
  taskStatusPhase,
  type WorkerTaskStream,
  type WorkerTaskStreamCallbacks,
} from "./engine-task-stream.ts";
export type { LoginSseFrame } from "./login-sessions.ts";
export type { OpenProjectStorage, PoolBoardEvent } from "./project-pool.ts";

export class Engine {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;
  readonly providers: ProvidersHandle;
  readonly settings: SettingsHandle;
  readonly skills: SkillsHandle;
  readonly mcp: EngineMcpAccessor;
  readonly projects: ProjectsHandle;

  readonly #ctx: EngineContext;
  readonly #state: EngineLifecycleState;
  #closePromise: Promise<void> | undefined;

  private constructor(ctx: EngineContext, state: EngineLifecycleState) {
    this.#ctx = ctx;
    this.#state = state;
    this.layout = ctx.layout;
    this.store = ctx.store;
    this.modelRuntime = ctx.modelRuntime;
    this.mcpHub = ctx.mcpHub;
    this.oauthStore = ctx.oauthStore;
    this.providers = ctx.providers;
    this.settings = ctx.settings;
    this.skills = ctx.skills;
    this.mcp = ctx.mcp;
    this.projects = ctx.projects;
  }

  static async open(options: EngineOptions = {}): Promise<Engine> {
    const state: EngineLifecycleState = { closed: false };
    const ctx = await openEngineContext(options, state);
    return new Engine(ctx, state);
  }

  models(): Models {
    return this.#ctx.models();
  }

  async openProject(projectId: string): Promise<ProjectHandle> {
    this.#ctx.assertOpen();
    return this.#ctx.pool.openProject(projectId);
  }

  isProjectOpen(projectId: string): boolean {
    return this.#ctx.pool.isProjectOpen(projectId);
  }

  acquireStream(projectId: string): () => void {
    return this.#ctx.pool.acquireStream(projectId);
  }

  subscribeBoardEvents(listener: (event: PoolBoardEvent) => void): () => void {
    this.#ctx.assertOpen();
    return this.#ctx.pool.subscribeBoardEvents(listener);
  }

  getCachedBoard(projectId: string): BoardView | undefined {
    return this.#ctx.pool.getCachedBoard(projectId);
  }

  cacheBoard(projectId: string, board: BoardView): void {
    this.#ctx.pool.cacheBoard(projectId, board);
  }

  async recoverProjects(): Promise<void> {
    this.#ctx.assertOpen();
    return this.#ctx.pool.recoverProjects();
  }

  hibernateIdleProjects(now = Date.now()): Promise<string[]> {
    return this.#ctx.pool.hibernateIdleProjects(now);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#dispose();
    return this.#closePromise;
  }

  async #dispose(): Promise<void> {
    this.#state.closed = true;
    await disposeEngineContext(this.#ctx);
  }
}
