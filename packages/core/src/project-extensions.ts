import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type Extension,
  type Harness,
  type Registry,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import {
  type CachedCompactionEvent,
  type CodemodeHandle,
  type CodemodeHandleOptions,
  createBaseExtension,
  createCachedCompactionExtension,
  createCodemodeHandle,
  createCodingToolsExtension,
  createReadonlyToolsExtension,
  createShellPathsExtension,
  createTasksExtension,
  createToolSearchExtension,
  type TaskManager,
} from "@eevee/agent";
import { accumulateUsage, createMemoryExtension, type MemoryBinding } from "@eevee/memory";
import { CompactionUsageDoc } from "./docs.ts";
import { createRouterExtension } from "./extensions/router.ts";
import { createWorkerExtension } from "./extensions/worker.ts";
import type { OpenProjectDeps } from "./project.ts";
import type { ModelSlots, ToolPolicy } from "./roles.ts";
import { SerialPass } from "./serial-pass.ts";

export type CompactionUsageTracker = {
  record(event: CachedCompactionEvent): void;
  idle(): Promise<void>;
  flushAndClose(): Promise<void>;
};

function isCodemodeHandle(value: CodemodeHandleOptions | CodemodeHandle): value is CodemodeHandle {
  return "extension" in value && "sandbox" in value && "close" in value;
}

export function resolveCodemode(
  option: OpenProjectDeps["codemode"],
  getToolPolicy: () => ToolPolicy | undefined,
): { readonly handle: CodemodeHandle | undefined; readonly owned: boolean } {
  if (option === false) return { handle: undefined, owned: false };
  if (option !== undefined && isCodemodeHandle(option)) return { handle: option, owned: false };
  const configuredBudget = option?.inlineBudget;
  return {
    handle: createCodemodeHandle({
      ...option,
      inlineBudget: () =>
        getToolPolicy()?.codemode?.inlineBudget ??
        (typeof configuredBudget === "function" ? configuredBudget() : configuredBudget),
    }),
    owned: true,
  };
}

export function createCompactionUsageTracker(
  getHarness: () => Harness,
  signal: AbortSignal,
  onPumpError: OpenProjectDeps["onPumpError"],
): CompactionUsageTracker {
  const pending: { modelKey: string; usage: Usage }[] = [];
  const pass = new SerialPass(
    async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await getHarness().commit(async (tx) => {
          const doc = await tx.doc(CompactionUsageDoc);
          for (const item of batch) {
            accumulateUsage(doc.models, item.modelKey, item.usage);
          }
        }, BACKGROUND_CONTEXT);
      }
    },
    onPumpError === undefined
      ? {}
      : {
          onError: (error) => {
            if (!signal.aborted) onPumpError(error);
          },
        },
  );
  return {
    record: (event) => {
      pending.push({
        modelKey: `${event.model.provider}/${event.model.modelId}`,
        usage: event.usage,
      });
      pass.request();
    },
    idle: () => pass.idle(),
    flushAndClose: async () => {
      if (pending.length > 0) pass.request();
      await pass.idle();
      pass.close();
    },
  };
}

export function installProjectExtensions(options: {
  readonly registry: Registry;
  readonly deps: OpenProjectDeps;
  readonly title: string;
  readonly taskManager: TaskManager;
  readonly codemode: CodemodeHandle | undefined;
  readonly onCompact: (event: CachedCompactionEvent) => void;
  readonly getWorkspaces: () => readonly string[];
  readonly getPrimaryWorkspace: () => string;
  readonly getModelSlots: () => ModelSlots;
  readonly getToolPolicy: () => ToolPolicy | undefined;
  readonly getMemoryBinding: () => MemoryBinding | undefined;
  readonly getHarness: () => Harness;
}): void {
  const { deps } = options;
  const extensions: Extension[] = [
    createBaseExtension({
      ...deps.baseExtensionOptions,
      workspaces: deps.baseExtensionOptions?.workspaces ?? options.getWorkspaces,
    }),
    createReadonlyToolsExtension(),
    createCodingToolsExtension({ powerShell: true, searchTools: true }),
    createShellPathsExtension(),
    createTasksExtension({
      manager: options.taskManager,
      ...(deps.backgroundAfterMs === undefined
        ? {}
        : { backgroundAfterMs: deps.backgroundAfterMs }),
    }),
    createToolSearchExtension(),
    createCachedCompactionExtension({ onCompact: options.onCompact }),
    ...(options.codemode === undefined ? [] : [options.codemode.extension]),
    createMemoryExtension({
      resolve: (conversationId) =>
        conversationId === ROOT_CONVERSATION_ID ? options.getMemoryBinding() : undefined,
    }),
    createRouterExtension({
      cwd: options.getPrimaryWorkspace,
      workerModel: () => {
        const slots = options.getModelSlots();
        return slots.worker ?? slots.router;
      },
      ...(deps.routerInstructions === undefined
        ? {}
        : { routerInstructions: deps.routerInstructions }),
      toolPolicy: options.getToolPolicy,
      project: () =>
        deps.projectMeta?.() ?? { title: options.title, workspaces: options.getWorkspaces() },
      ...(deps.projectMemory === undefined ? {} : { projectMemory: deps.projectMemory }),
      ...(deps.modelProfiles === undefined ? {} : { modelProfiles: deps.modelProfiles }),
      tasks: options.taskManager,
      readEntries: async (conversationId, limit, context) => {
        const conversation = await options.getHarness().conversation(conversationId, context);
        if (conversation === undefined) return [];
        const page = await conversation.entries({ order: "descending" }, limit, undefined, context);
        return [...page.items].reverse();
      },
    }),
    createWorkerExtension({
      ...(deps.projectMemory === undefined ? {} : { projectMemory: deps.projectMemory }),
      ...(deps.workerInstructions === undefined
        ? {}
        : { workerInstructions: deps.workerInstructions }),
    }),
    ...(deps.extensions ?? []),
  ];
  for (const extension of extensions) options.registry.install(extension);
}
