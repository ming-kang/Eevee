import { basename, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  Harness,
  type HarnessSettings,
  type Registry,
  type Storage,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  type CodemodeHandle,
  createManagedExecutionEnv,
  type McpHub,
  type ModelChoice,
  TaskManager,
} from "@eevee/agent";
import {
  createSummarizer,
  Dreamer,
  ENTRY_PAGE,
  type MemoryBinding,
  MemoryStore,
} from "@eevee/memory";
import type { OpenProjectDeps, ProjectMemoryHandle } from "./project.ts";
import {
  type CompactionUsageTracker,
  createCompactionUsageTracker,
  installProjectExtensions,
  resolveCodemode,
} from "./project-extensions.ts";
import { ProjectPump } from "./pump.ts";
import {
  openRootConversation,
  reconfigureRoles,
  resolveRouterCompactionSettings,
  resolveRouterMemoryBudget,
} from "./role-config.ts";
import type { ModelSlots, ToolPolicy } from "./roles.ts";
import { SerialPass } from "./serial-pass.ts";
import { BoardFeed, type BoardView, projectUsage } from "./views.ts";

export const DEFAULT_ROUTER_CONTEXT_TOKENS = 80_000;

export class ProjectRuntime {
  readonly tasks: TaskManager;
  readonly #deps: OpenProjectDeps;
  readonly #living = new AbortController();
  readonly #livingContext: Context;
  readonly #projectRoot: string;
  readonly #title: string;
  readonly #registry: Registry;
  readonly #ownsTaskManager: boolean;
  readonly #codemode: { readonly handle: CodemodeHandle | undefined; readonly owned: boolean };
  readonly #environments = new Map<string, NodeExecutionEnv>();
  readonly #compactionUsage: CompactionUsageTracker;

  #workspaces: readonly string[];
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #memoryBinding: MemoryBinding | undefined;
  #unbindMcp: (() => void) | undefined;
  #unsubscribeMcp: (() => void) | undefined;
  #boardFeed: BoardFeed | undefined;
  #pump: ProjectPump | undefined;
  #dreamer: Dreamer | undefined;
  #mcpSyncPass: SerialPass | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(deps: OpenProjectDeps) {
    this.#deps = deps;
    this.#livingContext = withAbortSignal(this.#living.signal, BACKGROUND_CONTEXT);
    this.#projectRoot = resolve(deps.cwd);
    const initialWorkspaces =
      deps.workspaces !== undefined && deps.workspaces.length > 0
        ? deps.workspaces
        : [this.#projectRoot];
    this.#workspaces = initialWorkspaces.map((dir) => resolve(this.#projectRoot, dir));
    this.#title = deps.title ?? (basename(this.#projectRoot) || this.#projectRoot);
    this.#registry = createRegistry();
    this.#ownsTaskManager = deps.taskManager === undefined;
    this.tasks =
      deps.taskManager ??
      new TaskManager(deps.taskLogPath === undefined ? {} : { logPath: deps.taskLogPath });
    this.#codemode = resolveCodemode(deps.codemode, () => this.#getToolPolicy());
    this.#compactionUsage = createCompactionUsageTracker(
      () => this.#requireHarness(),
      this.#living.signal,
      deps.onPumpError,
    );
  }

  async start(storage: Storage): Promise<{
    readonly harness: Harness;
    readonly root: Conversation;
    readonly memory: ProjectMemoryHandle;
  }> {
    try {
      installProjectExtensions({
        registry: this.#registry,
        deps: this.#deps,
        title: this.#title,
        taskManager: this.tasks,
        codemode: this.#codemode.handle,
        onCompact: this.#compactionUsage.record,
        getWorkspaces: () => this.#workspaces,
        getPrimaryWorkspace: () => this.#primaryWorkspace(),
        getModelSlots: () => this.#getModelSlots(),
        getToolPolicy: () => this.#getToolPolicy(),
        getMemoryBinding: () => this.#memoryBinding,
        getHarness: () => this.#requireHarness(),
      });
      this.#unbindMcp = this.#deps.mcpHub?.bindRegistry(this.#registry);

      const settings: HarnessSettings = {
        ...(this.#deps.settings ?? {}),
        steeringMode: this.#deps.settings?.steeringMode ?? "all",
        followUpMode: this.#deps.settings?.followUpMode ?? "all",
      };
      const harness = await Harness.open(
        storage,
        {
          models: () => this.#getModels(),
          registry: this.#registry,
          settings,
          ...(this.#deps.onReport === undefined ? {} : { onReport: this.#deps.onReport }),
          env: (target) => this.#envForTarget(target.cwd),
        },
        BACKGROUND_CONTEXT,
      );
      this.#harness = harness;

      const root = await openRootConversation({
        harness,
        registry: this.#registry,
        projectRoot: this.#projectRoot,
        models: this.#getModels(),
        hasModelSlots: this.#deps.modelSlots !== undefined,
        routerModel: this.#getModelSlots().router,
        routerContextTokens: this.#getRouterContextTokens(),
        toolPolicy: this.#getToolPolicy(),
        ...(this.#deps.memoryBudget === undefined ? {} : { memoryBudget: this.#deps.memoryBudget }),
        ...(this.#deps.settings?.compaction === undefined
          ? {}
          : { settingsCompaction: this.#deps.settings.compaction }),
        context: BACKGROUND_CONTEXT,
      });
      this.#root = root;

      const memoryStore = await MemoryStore.open(harness, root.id, this.#livingContext);
      const dreamer = new Dreamer({
        store: memoryStore,
        pager: (minEntryId, cursor, context) =>
          root.entries(
            { ...(minEntryId === undefined ? {} : { minEntryId }), order: "ascending" },
            ENTRY_PAGE,
            cursor,
            context,
          ),
        summarizer: () => {
          if (this.#deps.memorySummarizer !== undefined) return this.#deps.memorySummarizer();
          const choice = this.#getModelSlots().dreamer;
          return choice === undefined ? undefined : createSummarizer(this.#getModels(), choice);
        },
        harness,
        context: this.#livingContext,
        label: this.#title,
        ...(this.#deps.onPumpError === undefined
          ? {}
          : { onError: (error) => this.#deps.onPumpError?.(error) }),
      });
      this.#dreamer = dreamer;
      this.#memoryBinding = {
        store: memoryStore,
        budget: () =>
          resolveRouterMemoryBudget({
            models: this.#getModels(),
            model: this.#getModelSlots().router,
            routerContextTokens: this.#getRouterContextTokens(),
            ...(this.#deps.memoryBudget === undefined
              ? {}
              : { memoryBudget: this.#deps.memoryBudget }),
          }),
        sync: (context) => dreamer.sync(context),
      };

      this.#boardFeed = new BoardFeed(harness, {
        context: this.#livingContext,
        ...(this.#deps.onPumpError === undefined ? {} : { onError: this.#deps.onPumpError }),
      });
      this.#pump = new ProjectPump(harness, {
        ...(this.#deps.maxActiveWorkers === undefined
          ? {}
          : { maxActiveWorkers: this.#deps.maxActiveWorkers }),
        context: this.#livingContext,
        ...(this.#deps.onPumpError === undefined ? {} : { onError: this.#deps.onPumpError }),
      });

      this.#mcpSyncPass = new SerialPass(
        async () => {
          if (!this.#living.signal.aborted) await this.reconfigureTools(this.#livingContext);
        },
        this.#deps.onPumpError === undefined
          ? {}
          : {
              onError: (error) => {
                if (!this.#living.signal.aborted) this.#deps.onPumpError?.(error);
              },
            },
      );
      if (this.#deps.mcpHub !== undefined) {
        this.#unsubscribeMcp = this.#deps.mcpHub.subscribe(() => {
          this.#mcpSyncPass?.request();
        });
        this.#mcpSyncPass.request();
      }

      await this.reconfigureTools(this.#livingContext);
      await dreamer.sync(this.#livingContext);
      dreamer.wake();
      this.#pump.request();
      harness.resume();
      return { harness, root, memory: { store: memoryStore, dreamer } };
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  subscribeBoard(listener: (view: BoardView) => void): () => void {
    if (this.#boardFeed === undefined) throw new Error("Project board feed is not open");
    return this.#boardFeed.subscribe(listener);
  }

  requestPump(): void {
    this.#pump?.request();
  }

  async usage(context: Context): Promise<UsageState> {
    await this.#compactionUsage.idle();
    return projectUsage(this.#requireHarness(), this.#requireRoot().id, context);
  }

  async syncMcpExtensions(context: Context): Promise<void> {
    context.abortSignal?.throwIfAborted();
    this.#mcpSyncPass?.request();
    await this.#mcpSyncPass?.idle();
    context.abortSignal?.throwIfAborted();
  }

  async rebindMcpHub(nextHub: McpHub | undefined, context: Context): Promise<void> {
    context.abortSignal?.throwIfAborted();
    this.#unsubscribeMcp?.();
    this.#unsubscribeMcp = undefined;
    await this.#mcpSyncPass?.idle();
    context.abortSignal?.throwIfAborted();
    this.#unbindMcp?.();
    this.#unbindMcp = undefined;
    if (nextHub !== undefined) {
      this.#unbindMcp = nextHub.bindRegistry(this.#registry);
      this.#unsubscribeMcp = nextHub.subscribe(() => {
        this.#mcpSyncPass?.request();
      });
    }
    this.#mcpSyncPass?.request();
    await this.#mcpSyncPass?.idle();
    context.abortSignal?.throwIfAborted();
  }

  reconfigureTools(context: Context): Promise<void> {
    return reconfigureRoles(
      this.#requireHarness(),
      this.#requireRoot(),
      this.#registry.snapshot(),
      this.#getToolPolicy(),
      context,
    );
  }

  async reconfigureRouterModel(model: ModelChoice | undefined, context: Context): Promise<void> {
    const compaction = resolveRouterCompactionSettings({
      models: this.#getModels(),
      model,
      routerContextTokens: this.#getRouterContextTokens(),
      ...(this.#deps.memoryBudget === undefined ? {} : { memoryBudget: this.#deps.memoryBudget }),
      ...(this.#deps.settings?.compaction === undefined
        ? {}
        : { settingsCompaction: this.#deps.settings.compaction }),
    });
    await this.#requireRoot().configure(
      {
        model: model === undefined ? null : { provider: model.provider, modelId: model.modelId },
        thinkingLevel: model?.thinkingLevel ?? null,
        ...(compaction === undefined ? {} : { compaction }),
      },
      context,
    );
  }

  async reconfigureWorkspaces(workspaces: readonly string[], context: Context): Promise<void> {
    if (workspaces.length === 0) {
      throw new RangeError("reconfigureWorkspaces requires at least one workspace");
    }
    const previousPrimary = this.#primaryWorkspace();
    const next = workspaces.map((dir) => resolve(previousPrimary, dir));
    this.#workspaces = next;
    const nextPrimary = next[0] ?? this.#projectRoot;
    if (nextPrimary !== previousPrimary) {
      await this.#requireRoot().configure({ cwd: nextPrimary }, context);
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#dispose();
    return this.#closePromise;
  }

  #getModels(): Models {
    return typeof this.#deps.models === "function" ? this.#deps.models() : this.#deps.models;
  }

  #getModelSlots(): ModelSlots {
    const option = this.#deps.modelSlots;
    return typeof option === "function" ? option() : (option ?? {});
  }

  #getRouterContextTokens(): number {
    const option = this.#deps.routerContextTokens;
    return typeof option === "function" ? option() : (option ?? DEFAULT_ROUTER_CONTEXT_TOKENS);
  }

  #getToolPolicy(): ToolPolicy | undefined {
    return typeof this.#deps.toolPolicy === "function"
      ? this.#deps.toolPolicy()
      : this.#deps.toolPolicy;
  }

  #primaryWorkspace(): string {
    return this.#workspaces[0] ?? this.#projectRoot;
  }

  #requireHarness(): Harness {
    if (this.#harness === undefined) throw new Error("Project harness is not open yet");
    return this.#harness;
  }

  #requireRoot(): Conversation {
    if (this.#root === undefined) throw new Error("Project root conversation is not open yet");
    return this.#root;
  }

  #envForTarget(targetCwd: string | undefined): NodeExecutionEnv {
    const primary = this.#primaryWorkspace();
    const cwd = targetCwd === undefined ? primary : resolve(primary, targetCwd);
    let environment = this.#environments.get(cwd);
    if (environment === undefined) {
      environment = createManagedExecutionEnv({ cwd });
      this.#environments.set(cwd, environment);
    }
    return environment;
  }

  async #dispose(): Promise<void> {
    this.#living.abort();
    this.#unsubscribeMcp?.();
    this.#mcpSyncPass?.close();
    await this.#mcpSyncPass?.idle();
    await this.#boardFeed?.close();
    this.#pump?.close();
    await this.#pump?.idle();
    await this.#dreamer?.close();
    await this.#compactionUsage.flushAndClose();
    try {
      await this.#harness?.close(BACKGROUND_CONTEXT);
    } finally {
      this.#unbindMcp?.();
      if (this.#ownsTaskManager) await this.tasks.close().catch(() => undefined);
      if (this.#codemode.owned) await this.#codemode.handle?.close().catch(() => undefined);
      await Promise.all(
        [...this.#environments.values()].map((environment) =>
          environment.cleanup(BACKGROUND_CONTEXT).catch(() => undefined),
        ),
      );
    }
  }
}
