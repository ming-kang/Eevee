import { type FileHandle, open } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type { Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type CommitObservation,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type ConversationWindow,
  configure,
  createRegistry,
  type ConversationView as DurableView,
  defineExtension,
  type EntryQuery,
  type EntryRecord,
  type Extension,
  Harness,
  LiveDoc,
  type Registry,
  type ToolExecutionApi,
  ToolResultEntry,
  type Tx,
  UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  BoardView,
  ConversationView,
  JobLogView,
  MemoryCommitView,
  MemoryFileEntry,
  MemoryFileView,
  ProjectSummary,
  UsageView,
} from "../api/contract.ts";
import { Board, JobBoard, JobDoc, QuestionDoc, ReportLog, TicketDoc } from "../contracts/docs.ts";
import {
  type JobId,
  jobId,
  type MemoryScope,
  type ModelChoice,
  ProblemError,
  pickModel,
  type QuestionId,
  questionId,
  ROLE_NAMES,
  type RoleName,
  type Ticket,
  type TicketId,
} from "../contracts/index.ts";
import { createMemory, ensureDreamTimer, MemoryRepo } from "../extensions/memory/index.ts";
import {
  contextUsage,
  conversationOf,
  createOrchestration,
  type DeliveryContext,
  deliver,
  type EngineEvent,
  flush,
  NOTICE_KIND,
  openTicket,
  pump,
  readTicket,
  answerQuestion as recordAnswer,
  remindRouter,
  reportRunFailures,
  route,
  routerIdle,
  WorkerQueue,
} from "../extensions/orchestration/index.ts";
import { createResources } from "../extensions/resources/index.ts";
import { createWorkspace } from "../extensions/workspace/index.ts";
import { renderCatalog } from "../models/catalog.ts";
import { createRoles, type Roles } from "../roles/index.ts";
import { isNotFound, readText } from "../shared/fs.ts";
import { type EeveePaths, resolveInside } from "../shared/paths.ts";
import { SerialPass } from "../shared/serial-pass.ts";
import { enabledExtensions, type Settings } from "../shared/settings.ts";
import { BoardFeed, type BoardListener } from "./board-feed.ts";
import { JobHost } from "./jobs.ts";
import { type ProjectMeta, ProjectStore } from "./project.ts";
import { Reaper } from "./reaper.ts";
import { recentRounds, transcriptSource } from "./transcript.ts";
import { boardView, conversationView, usageView } from "./views.ts";

const TICK_MS = 250;
const UPKEEP_MS = 5_000;
const JOB_LOG_MAX_BYTES = 64 * 1024;
const JOB_LOG_DEFAULT_LINES = 200;
const INITIAL_MEMORY =
  "# Project memory\n\nThe core conventions every conversation needs to know, plus an index pointing to the topic notes.\n";
const INITIAL_GLOBAL_MEMORY =
  "# Global memory\n\nCross-project preferences about the user themselves; keep it very short.\n";

export type ProjectHostOptions = {
  paths: EeveePaths;
  meta: ProjectMeta;
  models: () => Models;
  settings: () => Settings;
  globalMemory: MemoryRepo;
  /** Extensions every project installs on top of Eevee's own; read again by `refreshExtensions()`. */
  shared: () => readonly Extension[];
  context: Context;
  upkeepMs?: number;
};

type Parts = {
  options: ProjectHostOptions;
  /** `project.json` as it is now; the roles read its models on every apply. */
  store: ProjectStore;
  harness: Harness;
  root: Conversation;
  registry: Registry;
  roles: Roles;
  jobs: JobHost;
  feed: BoardFeed;
  jobLog: (id: JobId) => string;
  repos: Record<MemoryScope, MemoryRepo>;
  shared: Set<string>;
  activeAt: number;
};

/**
 * One project: its Harness over `session.sqlite`, the extensions every conversation of it may select, the Router's
 * root conversation, and the loop that hands queued work to free slots and keeps the board moving.
 */
export class ProjectHost {
  readonly #store: ProjectStore;
  readonly #options: ProjectHostOptions;
  readonly #harness: Harness;
  readonly #root: Conversation;
  readonly #registry: Registry;
  readonly #roles: Roles;
  readonly #jobs: JobHost;
  readonly #feed: BoardFeed;
  readonly #jobLogPath: (id: JobId) => string;
  readonly #repos: Record<MemoryScope, MemoryRepo>;
  /** Names of the shared extensions installed now. */
  #shared: Set<string>;
  #activeAt: number;
  #activityWatch: CommitObservation | undefined;
  readonly #timer: NodeJS.Timeout;
  /** The dispatch loop: starts queued tickets and runs upkeep, on every timer tick. */
  readonly #ticker: SerialPass;
  readonly #reaper: Reaper;
  #lastUpkeep = 0;

  private constructor(parts: Parts) {
    this.#store = parts.store;
    this.#options = parts.options;
    this.#harness = parts.harness;
    this.#root = parts.root;
    this.#registry = parts.registry;
    this.#roles = parts.roles;
    this.#jobs = parts.jobs;
    this.#feed = parts.feed;
    this.#jobLogPath = parts.jobLog;
    this.#repos = parts.repos;
    this.#shared = parts.shared;
    this.#activeAt = parts.activeAt;
    this.#reaper = new Reaper({
      harness: parts.harness,
      jobs: parts.jobs,
      context: parts.options.context,
      label: parts.store.current.id,
    });
    this.#ticker = new SerialPass(
      () => this.#tick(),
      (error) => console.error(`[${this.meta.id}] The dispatch loop hit an error.`, error),
    );
    this.#timer = setInterval(() => this.#ticker.request(), TICK_MS);
    this.#timer.unref();
    this.#ticker.request();
  }

  static async open(options: ProjectHostOptions): Promise<ProjectHost> {
    const { meta, context } = options;
    const store = ProjectStore.open(options.paths, meta);
    const paths = options.paths.project(meta.id);
    const repos: Record<MemoryScope, MemoryRepo> = {
      project: new MemoryRepo(paths.memory),
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

    const memory = createMemory({
      repos,
      dreaming: {
        // Off while the dreamer has no model, so the timer never opens a ticket that cannot run.
        intervalMs: () =>
          defaultModel("dreamer") === undefined ? 0 : options.settings().dreamIntervalMs,
        open: async (tx, draft, { now, registry }, ctx) => {
          const ticket = await openTicket(
            tx,
            roles.ticketConversations,
            registry,
            { role: "dreamer", ...draft, deliverTo: [] },
            now,
            ctx,
          );
          return ticket.id;
        },
      },
    });
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
    const host = new ProjectHost({
      options,
      store,
      harness,
      root,
      registry,
      roles,
      jobs,
      feed,
      jobLog,
      repos,
      shared,
      activeAt,
    });
    await host.#applyRoles();
    const first = await root.entries({}, 1, undefined, context);
    if (first.items.length === 0)
      await root.reset(await roles.routerOpening(harness, context), context);
    await flush(delivery, context);
    await jobs.recover();
    await host.#reaper.start();
    await ensureDreamTimer(harness, root, memory.timer, context);
    host.#watchActivity();
    harness.resume();
    return host;
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  async sendUserMessage(text: string): Promise<void> {
    await this.#dispatch({ type: "user-message", id: crypto.randomUUID(), text });
  }

  async answerQuestion(id: QuestionId, answer: string): Promise<void> {
    const seed = await this.#harness.snapshot(QuestionDoc, id, this.#context);
    if (seed === undefined) throw new ProblemError({ code: "no_question", questionId: id });
    const now = Date.now();
    const answered = { ...seed, answer, answeredAt: now };
    await this.#dispatch({ type: "question-answered", question: answered }, async (tx) => {
      await recordAnswer(tx, id, answer, now);
    });
  }

  async messageWorker(id: TicketId, text: string, whenBusy: "steer" | "followUp"): Promise<void> {
    await this.#openTicket(id);
    await this.#dispatch({
      type: "panel-message",
      id: crypto.randomUUID(),
      ticketId: id,
      text,
      whenBusy,
    });
  }

  async interruptWorker(id: TicketId): Promise<void> {
    const worker = await this.#conversationOf(id);
    await this.#openTicket(id);
    await worker.abort(this.#context);
    await this.#dispatch({ type: "panel-interrupt", id: crypto.randomUUID(), ticketId: id });
  }

  /** Runs the Router's, or a ticket's, failed last turn again. */
  async retry(ticketId?: TicketId): Promise<void> {
    if (ticketId !== undefined) await this.#openTicket(ticketId);
    const conversation = await this.#conversationOf(ticketId);
    const live = await this.#harness.snapshot(LiveDoc, conversation.id, this.#context);
    if (live?.run !== undefined) throw new ProblemError({ code: "running" });
    if (live?.runFailure === undefined) throw new ProblemError({ code: "not_failed" });
    await conversation.submit({ type: "continue" }, this.#context);
  }

  get meta(): ProjectMeta {
    return this.#store.current;
  }

  /**
   * The project's own model for one role over the settings' default; `null` drops it. The Router and the open tickets
   * that chose no model take the result at once, from their next request.
   */
  async setProjectModel(role: RoleName | "default", choice: ModelChoice | null): Promise<void> {
    await this.#store.update((meta) => {
      const { models: own, ...rest } = meta;
      const models = { ...own };
      if (choice === null) delete models[role];
      else models[role] = choice;
      return Object.keys(models).length === 0 ? rest : { ...rest, models };
    });
    await this.#applyRoles();
  }

  /** Re-derives the agents of the Router and the open tickets, after a change to the settings' defaults. */
  applyModels(): Promise<void> {
    return this.#applyRoles();
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  summary(): ProjectSummary {
    return { ...this.meta, activeAt: this.#activeAt };
  }

  board(): Promise<BoardView> {
    return this.#feed.read();
  }

  watchBoard(listener: BoardListener): () => void {
    return this.#feed.subscribe(listener);
  }

  async killJob(id: JobId): Promise<void> {
    if (await this.#jobs.kill(id)) return;
    const job = await this.#harness.snapshot(JobDoc, id, this.#context);
    if (job === undefined) throw new ProblemError({ code: "no_job", jobId: id });
    throw new ProblemError({ code: "job_ended", jobId: id });
  }

  async jobLog(id: JobId, maxLines = JOB_LOG_DEFAULT_LINES): Promise<JobLogView> {
    const job = await this.#harness.snapshot(JobDoc, id, this.#context);
    if (job === undefined) throw new ProblemError({ code: "no_job", jobId: id });
    const tail = await readLogTail(this.#jobLogPath(id), maxLines);
    return { job, ...tail };
  }

  async conversation(limit = 100): Promise<ConversationView> {
    return conversationView(this.#harness, this.#root, limit, this.#context);
  }

  async ticketConversation(id: TicketId, limit = 200): Promise<ConversationView> {
    return conversationView(this.#harness, await this.#conversationOf(id), limit, this.#context);
  }

  usage(): Promise<UsageView> {
    return usageView(this.#harness, this.#context);
  }

  /** The Router's conversation, or a ticket's, as Durable's structural view; for the realtime stream. */
  async watch(
    ticketId: TicketId | undefined,
    context: Context,
    window?: ConversationWindow,
  ): Promise<WatchHandle<DurableView>> {
    return (await this.#conversationOf(ticketId)).watch(context, window);
  }

  /** A page of entries, for filling the gaps of a watched transcript. */
  async entries(
    ticketId: TicketId | undefined,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
  ): Promise<EntryRecord[]> {
    const conversation = await this.#conversationOf(ticketId);
    const page = await conversation.entries(query, limit, undefined, this.#context);
    return [...page.items];
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  memoryLog(scope: MemoryScope, limit?: number): Promise<MemoryCommitView[]> {
    return this.#repos[scope].history(limit);
  }

  memoryDiff(scope: MemoryScope, commit?: string): Promise<string> {
    return this.#repos[scope].diff(commit);
  }

  memoryRevert(scope: MemoryScope, commit: string): Promise<void> {
    return this.#repos[scope].revert(commit);
  }

  memoryFiles(scope: MemoryScope): Promise<MemoryFileEntry[]> {
    return this.#repos[scope].listFiles();
  }

  async memoryFile(scope: MemoryScope, file: string): Promise<MemoryFileView> {
    const repo = this.#repos[scope];
    const missingFile = new ProblemError({ code: "no_memory_file", file });
    let resolved: string;
    try {
      resolved = resolveInside(repo.dir, file);
    } catch {
      throw missingFile;
    }
    const rel = relative(repo.dir, resolved).replaceAll("\\", "/");
    if (rel === ".git" || rel.startsWith(".git/")) throw missingFile;
    const content = await repo.read(rel);
    if (content === undefined) throw missingFile;
    return { path: rel, content };
  }

  // ── Capabilities ───────────────────────────────────────────────────────────

  /** Installs the shared extensions as they are now and applies every role again. */
  async refreshExtensions(): Promise<void> {
    this.#shared = installShared(this.#registry, this.#shared, this.#options.shared());
    await this.#applyRoles();
  }

  /**
   * Applies the roles to the Router and to every open ticket: their extensions as settings.json enables them now, the
   * current default models where a ticket chose none. Writing an unchanged agent records nothing.
   */
  async #applyRoles(): Promise<void> {
    const snapshot = this.#registry.snapshot();
    const tickets: Ticket[] = [];
    for (const id of ((await this.#harness.snapshot(Board, this.#context))?.tickets ??
      []) as TicketId[]) {
      const ticket = await readTicket(this.#harness, id, this.#context);
      if (ticket?.status === "open") tickets.push(ticket);
    }
    await this.#root.commit(async (tx) => {
      await configure(tx, this.#root.id, this.#roles.agent("router", snapshot));
      for (const ticket of tickets) {
        const change = this.#roles.agent(ticket.role, snapshot, ticket.model);
        await configure(tx, conversationOf(ticket), change);
      }
    }, this.#context);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Stops taking work, waits for every background pass under way, then closes the jobs and the Session they use. */
  async close(): Promise<void> {
    this.#activityWatch?.detach();
    clearInterval(this.#timer);
    await Promise.all([this.#ticker.close(), this.#reaper.close(), this.#feed.close()]);
    await this.#jobs.close();
    await this.#harness.close(this.#context);
  }

  #watchActivity(): void {
    this.#activityWatch = this.#harness.observeCommits({
      advance: (pub) => {
        if (isActivityCommit(pub)) {
          this.#activeAt = Math.max(this.#activeAt, Date.now());
        }
        if (isBoardCommit(pub)) {
          this.#feed.invalidate();
        }
      },
      end: () => {},
    });
  }

  get #context(): Context {
    return this.#options.context;
  }

  async #tick(): Promise<void> {
    const host = deliveryHost(this.#harness, this.#root);
    const settings = this.#options.settings();
    this.#reaper.request();
    await pump(host, settings.maxActiveWorkers, this.#context);
    const now = Date.now();
    if (now - this.#lastUpkeep >= (this.#options.upkeepMs ?? UPKEEP_MS)) {
      this.#lastUpkeep = now;
      await reportRunFailures(host, now, this.#context);
      await remindRouter(host, { olderThan: settings.reminderAfterMs, now }, this.#context);
      await this.#nudgeHandoff(host, settings.handoffThreshold);
    }
  }

  async #nudgeHandoff(host: DeliveryContext, threshold: number): Promise<void> {
    if (!(await routerIdle(host, this.#context))) return;
    const fraction = await contextFraction(this.#root, this.#options.models(), this.#context);
    if (fraction <= threshold) return;
    const { epoch } = await contextUsage(this.#root, this.#context);
    await this.#dispatch({ type: "handoff-nudge", epoch });
  }

  async #dispatch(event: EngineEvent, change?: (tx: Tx) => Promise<void>): Promise<void> {
    await deliver(deliveryHost(this.#harness, this.#root), route(event), this.#context, change);
  }

  async #openTicket(id: TicketId) {
    const ticket = await this.#harness.snapshot(TicketDoc, id, this.#context);
    if (ticket === undefined) throw new ProblemError({ code: "no_ticket", ticketId: id });
    if (ticket.status !== "open") throw new ProblemError({ code: "ticket_closed", ticketId: id });
    return ticket;
  }

  /** The Router's conversation without `ticketId`, else the ticket's. */
  async #conversationOf(ticketId?: TicketId): Promise<Conversation> {
    if (ticketId === undefined) return this.#root;
    const ticket = await this.#harness.snapshot(TicketDoc, ticketId, this.#context);
    if (ticket === undefined) throw new ProblemError({ code: "no_ticket", ticketId });
    const conversation = await this.#harness.conversation(conversationOf(ticket), this.#context);
    if (conversation === undefined) throw new ProblemError({ code: "no_worker", ticketId });
    return conversation;
  }
}

/** Installs `next`, replacing extensions by name, and uninstalls the shared ones no longer in it. */
function installShared(
  registry: Registry,
  installed: ReadonlySet<string>,
  next: readonly Extension[],
): Set<string> {
  const names = new Set(next.map((e) => e.name));
  for (const name of installed) {
    if (!names.has(name)) registry.uninstall(defineExtension({ name }));
  }
  for (const extension of next) registry.install(extension);
  return names;
}

async function contextFraction(
  conversation: Conversation,
  models: Models,
  context: Context,
): Promise<number> {
  const model = (await conversation.agent(context)).model;
  const window = model && models.getModel(model.provider, model.modelId)?.contextWindow;
  if (!window) return 0;
  return (await contextUsage(conversation, context)).tokens / window;
}

function deliveryHost(harness: Harness, root: Conversation): DeliveryContext {
  return {
    snapshot: harness.snapshot.bind(harness) as ToolExecutionApi["snapshot"],
    conversation: (id: ConversationId, ctx: Context) => harness.conversation(id, ctx),
    commit: (change, ctx) => root.commit(change, ctx),
  };
}

const ACTIVITY_ENTRY_KINDS = new Set([
  UserEntry.kind,
  AssistantEntry.kind,
  ToolResultEntry.kind,
  NOTICE_KIND,
]);

const ACTIVITY_DOC_KINDS = new Set([
  Board.definition.kind,
  TicketDoc.definition.kind,
  ReportLog.definition.kind,
  QuestionDoc.definition.kind,
  JobDoc.definition.kind,
  JobBoard.definition.kind,
  LiveDoc.definition.kind,
]);

const BOARD_DOC_KINDS = new Set([
  Board.definition.kind,
  TicketDoc.definition.kind,
  ReportLog.definition.kind,
  QuestionDoc.definition.kind,
  LiveDoc.definition.kind,
  WorkerQueue.definition.kind,
]);

function isActivityCommit(pub: CommitPublication): boolean {
  return pub.changes.some(
    (c) =>
      (c.type === "entry" && ACTIVITY_ENTRY_KINDS.has(c.value.kind)) ||
      (c.type === "document" && ACTIVITY_DOC_KINDS.has(c.record.kind)),
  );
}

function isBoardCommit(pub: CommitPublication): boolean {
  return pub.changes.some((c) => c.type === "document" && BOARD_DOC_KINDS.has(c.record.kind));
}

async function initialActiveAt(
  harness: Harness,
  root: Conversation,
  createdAt: number,
  context: Context,
): Promise<number> {
  let latest = createdAt;
  const max = (t: number | undefined) => {
    if (typeof t === "number" && t > latest) latest = t;
  };
  const scanConversation = async (conv: Conversation, limit: number) => {
    const entries = await conv.entries({ order: "descending" }, limit, undefined, context);
    for (const entry of entries.items) {
      for (const msg of entry.model ?? []) {
        max((msg as { timestamp?: number }).timestamp);
      }
    }
  };
  const board = await harness.snapshot(Board, context);
  const ticketIds = (board?.tickets ?? []) as TicketId[];
  for (const id of ticketIds) {
    const ticket = await harness.snapshot(TicketDoc, id, context);
    max(ticket?.createdAt);
    max(ticket?.closedAt);
    const reports = await harness.snapshot(ReportLog, id, context);
    for (const report of reports?.reports ?? []) max(report.at);
    // A closed ticket's conversation ended by `closedAt`; only open ones can be newer than their docs.
    if (ticket?.status === "open") {
      const conv = await harness.conversation(conversationOf(ticket), context);
      if (conv !== undefined) await scanConversation(conv, 4);
    }
  }
  const jobBoard = await harness.snapshot(JobBoard, context);
  const nextJob = jobBoard?.nextJob ?? 1;
  for (let i = Math.max(1, nextJob - 10); i < nextJob; i++) {
    const job = await harness.snapshot(JobDoc, jobId(i), context);
    max(job?.startedAt);
    max(job?.endedAt);
  }
  const nextQuestion = board?.nextQuestion ?? 1;
  for (let i = Math.max(1, nextQuestion - 10); i < nextQuestion; i++) {
    const q = await harness.snapshot(QuestionDoc, questionId(i), context);
    max(q?.askedAt);
    max(q?.answeredAt);
  }
  await scanConversation(root, 10);
  return latest;
}

async function readLogTail(
  path: string,
  maxLines: number,
): Promise<{ content: string; truncated: boolean }> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNotFound(error)) return { content: "", truncated: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { content: "", truncated: false };
    const readBytes = Math.min(size, JOB_LOG_MAX_BYTES);
    const offset = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    let totalRead = 0;
    while (totalRead < readBytes) {
      const { bytesRead } = await handle.read(
        buf,
        totalRead,
        readBytes - totalRead,
        offset + totalRead,
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    let text = buf.subarray(0, totalRead).toString("utf8");
    const truncatedByBytes = offset > 0;
    if (truncatedByBytes) {
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        text = text.slice(nl + 1);
      } else if (text.startsWith("\uFFFD")) {
        text = text.replace(/^\uFFFD+/, "");
      }
    }
    const lines = text.split(/\r?\n/);
    const hasTrailingNewline = lines.length > 1 && lines.at(-1) === "";
    const bodyLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
    const truncatedByLines = bodyLines.length > maxLines;
    const tailLines = truncatedByLines ? bodyLines.slice(-maxLines) : bodyLines;
    return {
      content: tailLines.join("\n") + (hasTrailingNewline && tailLines.length > 0 ? "\n" : ""),
      truncated: truncatedByBytes || truncatedByLines,
    };
  } finally {
    await handle.close();
  }
}
