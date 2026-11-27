import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AgentDoc,
  type AgentState,
  type CompactionSettings,
  type Conversation,
  type Extension,
  type Harness,
  type Registry,
  type RegistrySnapshot,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { ModelChoice } from "@eevee/agent";
import { type RecallBudget, recallBudget } from "@eevee/memory";
import { readWorkers } from "./docs.ts";
import {
  buildRouterAgent,
  resolveRoleExtensions,
  resolveRoleToolFilters,
  type ToolPolicy,
  type WorkerRole,
} from "./roles.ts";

export function sameExtensionOrder(
  current: readonly Extension[],
  desired: readonly Extension[],
): boolean {
  return (
    current.length === desired.length &&
    current.every((extension, idx) => extension.name === desired[idx]?.name)
  );
}

export function sameToolNames(
  current: readonly string[],
  desired: readonly { readonly name: string }[],
): boolean {
  const currentNames = new Set(current);
  const desiredNames = new Set(desired.map((tool) => tool.name));
  return (
    currentNames.size === desiredNames.size &&
    [...currentNames].every((name) => desiredNames.has(name))
  );
}

export function hasModelToolsRemoveFilter(state: Readonly<AgentState> | undefined): boolean {
  const filter = state?.modelTools;
  return filter !== undefined && !Array.isArray(filter) && Object.hasOwn(filter, "remove");
}

export function roleToolFilterChanges(
  role: WorkerRole,
  extensions: readonly Extension[],
  state: Readonly<AgentState> | undefined,
  policy: ToolPolicy | undefined,
): {
  readonly tools: AgentChange["tools"];
  readonly modelTools: AgentChange["modelTools"];
} {
  const desired = resolveRoleToolFilters(role, extensions, policy);
  const currentTools = state?.tools;
  const toolsUnchanged =
    desired.tools === null
      ? currentTools === undefined ||
        (!Array.isArray(currentTools) && currentTools.remove.length === 0)
      : currentTools !== undefined &&
        !Array.isArray(currentTools) &&
        sameToolNames(currentTools.remove, desired.tools.remove);

  let modelTools: AgentChange["modelTools"];
  if (desired.modelTools === null) {
    modelTools = hasModelToolsRemoveFilter(state) ? null : undefined;
  } else {
    const currentModelTools = state?.modelTools;
    const modelToolsUnchanged =
      hasModelToolsRemoveFilter(state) &&
      currentModelTools !== undefined &&
      !Array.isArray(currentModelTools) &&
      sameToolNames(currentModelTools.remove ?? [], desired.modelTools.remove);
    modelTools = modelToolsUnchanged ? undefined : desired.modelTools;
  }
  return {
    tools: toolsUnchanged ? undefined : desired.tools,
    modelTools,
  };
}

export async function configureRoleConversation(
  harness: Harness,
  conversation: Conversation,
  role: WorkerRole,
  snapshot: RegistrySnapshot,
  policy: ToolPolicy | undefined,
  context: Context,
): Promise<void> {
  const extensions = resolveRoleExtensions(role, snapshot, policy);
  const [current, state] = await Promise.all([
    conversation.agent(context),
    harness.snapshot(AgentDoc, conversation.id, context),
  ]);
  const filters = roleToolFilterChanges(role, extensions, state, policy);
  const change: AgentChange = {
    ...(sameExtensionOrder(current.extensions, extensions) ? {} : { extensions }),
    ...(filters.tools === undefined ? {} : { tools: filters.tools }),
    ...(filters.modelTools === undefined ? {} : { modelTools: filters.modelTools }),
  };
  if (Object.keys(change).length > 0) await conversation.configure(change, context);
}

export async function reconfigureRoles(
  harness: Harness,
  root: Conversation,
  snapshot: RegistrySnapshot,
  policy: ToolPolicy | undefined,
  context: Context,
): Promise<void> {
  await Promise.all([
    configureRoleConversation(harness, root, "router", snapshot, policy, context),
    readWorkers(harness, context).then((workers) =>
      Promise.all(
        workers
          .filter((worker) => worker.closedAt === undefined)
          .map(async (worker) => {
            const conversation = await harness.conversation(worker.conversationId, context);
            if (conversation !== undefined) {
              await configureRoleConversation(
                harness,
                conversation,
                "worker",
                snapshot,
                policy,
                context,
              );
            }
          }),
      ),
    ),
  ]);
}

export function resolveRouterMemoryBudget(options: {
  readonly models: Models;
  readonly model: ModelChoice | undefined;
  readonly routerContextTokens: number;
  readonly memoryBudget?: () => RecallBudget;
}): RecallBudget {
  if (options.memoryBudget !== undefined) return options.memoryBudget();
  const contextWindow =
    options.model === undefined
      ? undefined
      : options.models.getModel(options.model.provider, options.model.modelId)?.contextWindow;
  return recallBudget(contextWindow, options.routerContextTokens);
}

export function resolveRouterCompactionSettings(options: {
  readonly models: Models;
  readonly model: ModelChoice | undefined;
  readonly routerContextTokens: number;
  readonly memoryBudget?: () => RecallBudget;
  readonly settingsCompaction?: CompactionSettings;
}): CompactionSettings | null | undefined {
  if (options.memoryBudget === undefined && options.settingsCompaction !== undefined) {
    return undefined;
  }
  return resolveRouterMemoryBudget(options).compaction;
}

export async function openRootConversation(options: {
  readonly harness: Harness;
  readonly registry: Registry;
  readonly projectRoot: string;
  readonly models: Models;
  readonly hasModelSlots: boolean;
  readonly routerModel: ModelChoice | undefined;
  readonly routerContextTokens: number;
  readonly toolPolicy: ToolPolicy | undefined;
  readonly memoryBudget?: () => RecallBudget;
  readonly settingsCompaction?: CompactionSettings;
  readonly context: Context;
}): Promise<Conversation> {
  const initialCompaction = resolveRouterCompactionSettings({
    models: options.models,
    model: options.routerModel,
    routerContextTokens: options.routerContextTokens,
    ...(options.memoryBudget === undefined ? {} : { memoryBudget: options.memoryBudget }),
    ...(options.settingsCompaction === undefined
      ? {}
      : { settingsCompaction: options.settingsCompaction }),
  });
  const snapshot = options.registry.snapshot();
  const routerAgent = buildRouterAgent({
    snapshot,
    ...(options.routerModel === undefined ? {} : { model: options.routerModel }),
    cwd: options.projectRoot,
    ...(initialCompaction == null ? {} : { compaction: initialCompaction }),
    toolPolicy: options.toolPolicy,
  });

  const rootExisted =
    (await options.harness.conversation(ROOT_CONVERSATION_ID, options.context)) !== undefined;
  const root = await options.harness.root(options.context, { agent: routerAgent });
  if (rootExisted) {
    const clearModelFields = !options.hasModelSlots
      ? {}
      : options.routerModel === undefined
        ? ({ model: null, thinkingLevel: null } as const)
        : options.routerModel.thinkingLevel === undefined
          ? ({ thinkingLevel: null } as const)
          : {};
    const routerExtensions = resolveRoleExtensions("router", snapshot, options.toolPolicy);
    const routerState = await options.harness.snapshot(AgentDoc, root.id, options.context);
    const filters = roleToolFilterChanges(
      "router",
      routerExtensions,
      routerState,
      options.toolPolicy,
    );
    await root.configure(
      {
        ...routerAgent,
        tools: filters.tools,
        modelTools: filters.modelTools,
        ...clearModelFields,
        instructions: null,
      },
      options.context,
    );
  }
  return root;
}
