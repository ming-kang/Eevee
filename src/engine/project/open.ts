import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  createRegistry,
  type Extension,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { enabledExtensions, type Settings } from "../../config/settings.ts";
import { type MemoryScope, pickModel, ROLE_NAMES, type RoleName } from "../../domain/index.ts";
import { readText } from "../../shared/fs.ts";
import type { EeveePaths } from "../../shared/paths.ts";
import { initialActiveAt, isActivityCommit } from "../activity.ts";
import { BoardFeed, isBoardCommit } from "../board-feed.ts";
import { createMemory } from "../extensions/memory/index.ts";
import { createOrchestration } from "../extensions/orchestration/index.ts";
import { createResources } from "../extensions/resources/index.ts";
import { createWorkspace } from "../extensions/workspace/index.ts";
import { JobHost } from "../jobs.ts";
import { MemoryStore } from "../memory/store.ts";
import { renderCatalog } from "../models/catalog.ts";
import { type DeliveryContext, flush } from "../orchestration/index.ts";
import { createRoles } from "../roles/index.ts";
import { contextFraction, deliveryHost, Scheduler } from "../scheduler.ts";
import { recentRounds, transcriptSource } from "../transcript.ts";
import { boardView, usageView } from "../views.ts";
import { Conversations } from "./conversations.ts";
import { createDispatcher } from "./dispatch.ts";
import { Dreaming } from "./dreaming.ts";
import { Jobs } from "./jobs.ts";
import { INITIAL_GLOBAL_MEMORY, Memory } from "./memory.ts";
import { Project } from "./project.ts";
import { Questions } from "./questions.ts";
import { installShared, ProjectSettings } from "./settings.ts";
import { type ProjectMeta, ProjectStore } from "./store.ts";

const INITIAL_MEMORY =
  "# Project memory\n\nThe core conventions every conversation needs to know, plus an index pointing to the topic notes.\n";

export type ProjectOptions = {
  paths: EeveePaths;
  meta: ProjectMeta;
  models: () => Models;
  settings: () => Settings;
  globalMemory: MemoryStore;
  /** Extensions every project installs on top of Eevee's own; read again by `refreshExtensions()`. */
  shared: () => readonly Extension[];
  context: Context;
  upkeepMs?: number;
  changed?: () => void;
};

export async function openProject(options: ProjectOptions): Promise<Project> {
  const { meta, context } = options;
  const store = ProjectStore.open(options.paths, meta);
  const paths = options.paths.project(meta.id);
  const repos: Record<MemoryScope, MemoryStore> = {
    project: new MemoryStore(paths.memory),
    global: options.globalMemory,
  };
  await repos.project.ensure(INITIAL_MEMORY);
  await repos.global.ensure(INITIAL_GLOBAL_MEMORY);

  // The Harness opens after the extensions that need it are built; they reach it through these.
  let harness: Harness | undefined;
  let delivery: DeliveryContext | undefined;
  const late = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error("The Harness is not open yet");
    return value;
  };
  const conversation = (id: ConversationId, ctx: Context) => late(harness).conversation(id, ctx);
  const defaultModel = (role: RoleName) =>
    pickModel(role, store.current.models, options.settings().models);

  const jobLog = (id: string) => join(paths.jobs, `${id}.log`);
  let jobs: JobHost | undefined;
  const feed = new BoardFeed(() =>
    boardView(late(harness), (id) => late(jobs).running(id), context),
  );
  jobs = new JobHost({
    logPath: jobLog,
    delivery: () => late(delivery),
    onChange: () => feed.invalidate(),
    context,
  });

  const reported = new Set<string>();
  const roles = createRoles({
    project: { title: meta.title, workspace: meta.workspace },
    memory: async () => ({
      global: (await repos.global.read("MEMORY.md")) ?? "",
      project: (await repos.project.read("MEMORY.md")) ?? "",
    }),
    defaultModel,
    enabled: (role) => enabledExtensions(options.settings(), role),
    maxTurns: (role) => options.settings().roles[role]?.maxTurns,
    recent: async (id, rounds, ctx) => {
      const found = await conversation(id, ctx);
      return found === undefined ? "" : recentRounds(found, rounds, ctx);
    },
    onMissing: (role, missing) => {
      const fresh = missing.filter((name) => !reported.has(`${role}:${name}`));
      for (const name of fresh) reported.add(`${role}:${name}`);
      if (fresh.length > 0) {
        console.error(
          `[${meta.id}] The ${role} enables extensions that are not installed. Skipping them for now: ${fresh.join(", ")}`,
        );
      }
    },
  });

  const memory = createMemory({ repos });
  const orchestration = createOrchestration({
    conversations: roles.ticketConversations,
    handoff: {
      shouldHandoff: async (id, ctx) => {
        const found = await conversation(id, ctx);
        if (found === undefined) return false;
        const fraction = await contextFraction(found, options.models(), ctx);
        return fraction > options.settings().handoffThreshold;
      },
    },
  });

  const registry = createRegistry();
  const native = [
    createResources({
      memoryDir: (scope) => repos[scope].dir,
      jobLog,
      models: async () =>
        renderCatalog({
          models: options.models(),
          defaults: Object.fromEntries(ROLE_NAMES.map((role) => [role, defaultModel(role)])),
          profiles: await readText(options.paths.modelProfiles),
        }),
      transcript: transcriptSource(conversation),
    }),
    createWorkspace({ backgroundAfterMs: () => options.settings().backgroundAfterMs, jobs }),
    memory.memory,
    memory.projectMemory,
    orchestration.dispatch,
    orchestration.reporting,
    roles.extension,
  ];
  for (const extension of native) registry.install(extension);
  const shared = installShared(registry, new Set(), options.shared());

  harness = await Harness.open(
    await openNodeSqliteStorage(paths.session),
    {
      models: options.models,
      registry,
      env: ({ cwd = meta.workspace }) => new NodeExecutionEnv({ cwd }),
      onReport: (report) => console.error(`[${meta.id}]`, report),
    },
    context,
  );
  const root = await harness.root(context, {
    agent: roles.agent("router", registry.snapshot()),
  });
  delivery = deliveryHost(harness, root);

  const activeAt = await initialActiveAt(harness, root, meta.createdAt, context);

  let scheduler: Scheduler | undefined;
  let currentActiveAt = activeAt;
  const settings = new ProjectSettings(
    {
      store,
      root,
      harness,
      registry,
      roles,
      context,
      shared: options.shared,
      request: () => scheduler?.request(),
    },
    shared,
  );
  await settings.initialize();
  const first = await root.entries({}, 1, undefined, context);
  if (first.items.length === 0)
    await root.reset(await roles.routerOpening(harness, context), context);
  await flush(delivery, context);
  await jobs.recover();
  const watcher = harness.observeCommits({
    advance: (pub) => {
      if (isActivityCommit(pub)) {
        currentActiveAt = Math.max(currentActiveAt, Date.now());
        options.changed?.();
      }
      if (isBoardCommit(pub)) feed.invalidate();
      scheduler?.hear(pub);
    },
    end: () => {},
  });
  const dreaming = new Dreaming({
    id: meta.id,
    settings: options.settings,
    store,
    root,
    harness,
    registry,
    roles,
    jobs,
    context,
    activeAt: () => currentActiveAt,
  });
  scheduler = await Scheduler.start({
    harness,
    root,
    jobs,
    settings: options.settings,
    models: options.models,
    context,
    label: meta.id,
    ...(options.upkeepMs === undefined ? {} : { upkeepMs: options.upkeepMs }),
    dream: async (now) => {
      await Promise.all(Object.values(repos).map((repo) => repo.captureUserEdits()));
      await dreaming.run(now);
    },
  });
  const dispatch = createDispatcher(harness, root, context);
  const project = new Project({
    changed: options.changed,
    store,
    settings,
    feed,
    conversations: new Conversations({ harness, root, context, dispatch }),
    questions: new Questions({ harness, context, dispatch }),
    jobs: new Jobs({ harness, context, jobs, jobLogPath: jobLog }),
    memory: new Memory(repos),
    activeAt: () => currentActiveAt,
    usage: () => usageView(harness, context),
    close: async () => {
      watcher.detach();
      await Promise.all([scheduler?.close(), feed.close()]);
      await jobs.close();
      await harness.close(context);
    },
  });
  harness.resume();
  return project;
}
