import { join, relative } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CommitObservation,
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
  InboxDoc,
  type InboxItem,
  LiveDoc,
  type Registry,
  type SubmissionId,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { enabledExtensions, type Settings } from "../config/settings.ts";
import type { NoticeData } from "../domain/details.ts";
import {
  type JobId,
  type MemoryScope,
  type ModelChoice,
  ProblemError,
  pickModel,
  type Question,
  type QuestionId,
  ROLE_NAMES,
  type RoleName,
  type Ticket,
  type TicketId,
} from "../domain/index.ts";
import type {
  BoardView,
  ConversationView,
  JobLogView,
  MemoryFileView,
  ProjectSummary,
  UsageView,
} from "../protocol/contract.ts";
import { readText } from "../shared/fs.ts";
import { type EeveePaths, resolveInside } from "../shared/paths.ts";
import { initialActiveAt, isActivityCommit } from "./activity.ts";
import { BoardFeed, type BoardListener, isBoardCommit } from "./board-feed.ts";
import { Board, JobDoc, QuestionDoc, TicketDoc } from "./docs.ts";
import {
  createMemory,
  type DreamingPort,
  dreamIfDue,
  MemoryRepo,
} from "./extensions/memory/index.ts";
import {
  conversationOf,
  createOrchestration,
  type DeliveryContext,
  deliver,
  type EngineEvent,
  flush,
  NOTICE_KIND,
  openTicket,
  readTicket,
  answerQuestion as recordAnswer,
  route,
  routerIdle,
  WorkerQueue,
} from "./extensions/orchestration/index.ts";
import { createResources } from "./extensions/resources/index.ts";
import { createWorkspace } from "./extensions/workspace/index.ts";
import { JOB_LOG_DEFAULT_LINES, JobHost, readLogTail } from "./jobs.ts";
import { renderCatalog } from "./models/catalog.ts";
import { type ProjectMeta, ProjectStore } from "./project.ts";
import { createRoles, type Roles } from "./roles/index.ts";
import { contextFraction, deliveryHost, Scheduler } from "./scheduler.ts";
import { recentRounds, transcriptSource } from "./transcript.ts";
import { boardView, conversationView, usageView } from "./views.ts";

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
  #shared: Set<string>;
  #activeAt: number;
  #watcher: CommitObservation | undefined;
  #scheduler: Scheduler | undefined;

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
    host.#watchCommits();
    host.#scheduler = await Scheduler.start({
      harness,
      root,
      jobs,
      settings: options.settings,
      models: options.models,
      context,
      label: meta.id,
      ...(options.upkeepMs === undefined ? {} : { upkeepMs: options.upkeepMs }),
      dream: (now) => host.#dream(now),
    });
    harness.resume();
    return host;
  }

  async sendUserMessage(text: string): Promise<void> {
    await this.#dispatch({ type: "user-message", id: crypto.randomUUID(), text });
  }

  async answerQuestion(id: QuestionId, answer: string, answers?: string[]): Promise<void> {
    const seed = await this.#harness.snapshot(QuestionDoc, id, this.#context);
    if (seed === undefined) throw new ProblemError({ code: "no_question", questionId: id });
    if (answers !== undefined && answers.length !== seed.items.length) {
      throw new ProblemError({ code: "invalid", field: "answers" });
    }
    const now = Date.now();
    const answered = {
      ...seed,
      answer,
      answeredAt: now,
      ...(answers === undefined ? {} : { answers }),
    };
    await this.#dispatch({ type: "question-answered", question: answered }, async (tx) => {
      await recordAnswer(tx, id, answer, now, answers);
    });
  }

  /** A question in any state — open, answered, or withdrawn — for the review card. */
  async question(id: QuestionId): Promise<Question> {
    const question = await this.#harness.snapshot(QuestionDoc, id, this.#context);
    if (question === undefined) throw new ProblemError({ code: "no_question", questionId: id });
    return question;
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

  async interruptRouter(): Promise<void> {
    await this.#interrupt(this.#root);
  }

  async interruptWorker(id: TicketId): Promise<void> {
    const worker = await this.#conversationOf(id);
    await this.#openTicket(id);
    await this.#interrupt(worker);
    await this.#dispatch({ type: "panel-interrupt", id: crypto.randomUUID(), ticketId: id });
  }

  /**
   * Ends the conversation's turn and pulls its queued inputs. Engine notices among them — reports,
   * answers, job results `tell` had queued — are written back as records so the next run reads them;
   * the user's own queued lines stay withdrawn.
   */
  async #interrupt(conversation: Conversation): Promise<void> {
    const inbox = await this.#harness.snapshot(InboxDoc, conversation.id, this.#context);
    const kept = (inbox?.items ?? []).filter(
      (item) => item.mode !== "write" && item.entry?.kind === NOTICE_KIND,
    );
    await conversation.abort(this.#context);
    if (kept.length === 0) return;
    await conversation.commit(async (tx) => {
      for (const item of kept) {
        if (item.mode === "write") continue;
        const data = (item.entry?.data ?? {}) as NoticeData;
        const requestId = `${data.requestId ?? item.id}:kept`;
        await conversation.submit(tx, {
          type: "write",
          requestId,
          entry: {
            kind: NOTICE_KIND,
            data: { ...data, requestId },
            model: [{ role: "user", content: item.content, timestamp: Date.now() }],
          },
        });
      }
    }, this.#context);
  }

  /** Pulls one of the user's own queued inputs back; Engine notices and anything placed refuse. */
  async withdrawQueued(ticketId: TicketId | undefined, submissionId: string): Promise<void> {
    const conversation = await this.#conversationOf(ticketId);
    const item = await this.#queuedItem(conversation, submissionId);
    if (item !== undefined && (item.mode === "write" || item.entry !== undefined)) {
      throw new ProblemError({ code: "no_submission", submissionId });
    }
    await this.#abortSubmission(conversation, submissionId);
    if (ticketId !== undefined && item !== undefined) {
      await this.#dispatch({
        type: "panel-withdrawn",
        id: submissionId,
        ticketId,
        text: inputText(item.content),
      });
    }
  }

  /** Turns a queued followUp into a steer at the next postTools boundary. */
  async steerQueued(ticketId: TicketId, submissionId: string): Promise<void> {
    await this.#openTicket(ticketId);
    const conversation = await this.#conversationOf(ticketId);
    const item = await this.#queuedItem(conversation, submissionId);
    if (item === undefined || item.mode !== "followUp" || item.entry !== undefined) {
      throw new ProblemError({ code: "no_submission", submissionId });
    }
    await this.#abortSubmission(conversation, submissionId);
    await conversation.submit(
      {
        type: "input",
        requestId: `steer:${submissionId}`,
        content: item.content as UserInput,
        whenBusy: "steer",
      },
      this.#context,
    );
  }

  async #queuedItem(
    conversation: Conversation,
    submissionId: string,
  ): Promise<InboxItem | undefined> {
    const inbox = await this.#harness.snapshot(InboxDoc, conversation.id, this.#context);
    return inbox?.items.find((item) => String(item.id) === submissionId);
  }

  async #abortSubmission(conversation: Conversation, submissionId: string): Promise<void> {
    const result = await this.#harness.abortSubmission(
      Number(submissionId) as SubmissionId,
      this.#context,
      conversation.id,
    );
    if (result === "already_placed" || result === "settled") {
      throw new ProblemError({ code: "already_delivered" });
    }
    if (result === "not_found") {
      throw new ProblemError({ code: "no_submission", submissionId });
    }
  }

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
  async applyModels(): Promise<void> {
    await this.#applyRoles();
    this.#scheduler?.request();
  }

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

  memory(scope: MemoryScope): MemoryRepo {
    return this.#repos[scope];
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

  async refreshExtensions(): Promise<void> {
    this.#shared = installShared(this.#registry, this.#shared, this.#options.shared());
    await this.#applyRoles();
    this.#scheduler?.request();
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

  /**
   * Stops hearing commits first, then waits for every background pass under way, so nothing they do reaches the
   * jobs and the Session once they are closed.
   */
  async close(): Promise<void> {
    this.#watcher?.detach();
    await Promise.all([this.#scheduler?.close(), this.#feed.close()]);
    await this.#jobs.close();
    await this.#harness.close(this.#context);
  }

  /** The project's one commit observer: activity time, the board feed, and the Scheduler all hear the same commit. */
  #watchCommits(): void {
    this.#watcher = this.#harness.observeCommits({
      advance: (pub) => {
        if (isActivityCommit(pub)) {
          this.#activeAt = Math.max(this.#activeAt, Date.now());
        }
        if (isBoardCommit(pub)) {
          this.#feed.invalidate();
        }
        this.#scheduler?.hear(pub);
      },
      end: () => {},
    });
  }

  get #context(): Context {
    return this.#options.context;
  }

  async #dispatch(event: EngineEvent, change?: (tx: Tx) => Promise<void>): Promise<void> {
    await deliver(deliveryHost(this.#harness, this.#root), route(event), this.#context, change);
  }

  async #dream(now: number): Promise<void> {
    const port: DreamingPort = {
      // Off while the dreamer has no model, so it never opens a ticket that cannot run.
      policy: () => {
        const dreaming = this.#options.settings().dreaming;
        const model = pickModel(
          "dreamer",
          this.#store.current.models,
          this.#options.settings().models,
        );
        return dreaming.enabled && model !== undefined ? dreaming : undefined;
      },
      idleSince: (context) => this.#idleSince(context),
      contextOf: async (id, context) => {
        const found = await this.#harness.conversation(id, context);
        if (found === undefined) return { entries: [] };
        return { entries: [...(await found.context(context)).entries] };
      },
      open: async (tx, draft, now, context) => {
        const ticket = await openTicket(
          tx,
          this.#roles.ticketConversations,
          this.#registry.snapshot(),
          { role: "dreamer", ...draft, deliverTo: [] },
          now,
          context,
        );
        return ticket.id;
      },
    };
    const opened = await dreamIfDue(
      deliveryHost(this.#harness, this.#root),
      port,
      now,
      this.#context,
    );
    if (opened !== undefined) console.error(`[${this.meta.id}] Dreaming opened ${opened}.`);
  }

  /** When the project went idle: `undefined` while the Router, a Worker, a queued start or a job runs. */
  async #idleSince(context: Context): Promise<number | undefined> {
    const host = deliveryHost(this.#harness, this.#root);
    if (!(await routerIdle(host, context))) return undefined;
    if (((await host.snapshot(WorkerQueue, context))?.pending.length ?? 0) > 0) {
      return undefined;
    }
    for (const id of (await host.snapshot(Board, context))?.tickets ?? []) {
      const ticket = await readTicket(host, id, context);
      if (ticket?.status !== "open") continue;
      if ((await host.snapshot(LiveDoc, conversationOf(ticket), context))?.run !== undefined) {
        return undefined;
      }
    }
    if (this.#jobs.running().length > 0) return undefined;
    return this.#activeAt;
  }

  async #openTicket(id: TicketId) {
    const ticket = await this.#harness.snapshot(TicketDoc, id, this.#context);
    if (ticket === undefined) throw new ProblemError({ code: "no_ticket", ticketId: id });
    if (ticket.status !== "open") throw new ProblemError({ code: "ticket_closed", ticketId: id });
    return ticket;
  }

  async #conversationOf(ticketId?: TicketId): Promise<Conversation> {
    if (ticketId === undefined) return this.#root;
    const ticket = await this.#harness.snapshot(TicketDoc, ticketId, this.#context);
    if (ticket === undefined) throw new ProblemError({ code: "no_ticket", ticketId });
    const conversation = await this.#harness.conversation(conversationOf(ticket), this.#context);
    if (conversation === undefined) throw new ProblemError({ code: "no_worker", ticketId });
    return conversation;
  }
}

/** An inbox input's text, for a notice that quotes what the user had queued. */
function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("")
    .trim();
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
