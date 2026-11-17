import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  Harness,
  LiveDoc,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { BoardView, ConversationView, TicketView } from "../api/contract.ts";
import { Board, QuestionDoc, ReportLog, TicketDoc } from "../contracts/docs.ts";
import { deriveStage, pickModel, type QuestionId, type TicketId } from "../contracts/index.ts";
import { createMemory, MemoryRepo } from "../extensions/memory/index.ts";
import { conversationOf } from "../extensions/orchestration/board.ts";
import {
  contextUsage,
  createOrchestration,
  type DeliveryContext,
  deliver,
  type EngineEvent,
  flush,
  pump,
  queuedTickets,
  remindRouter,
  route,
  routerIdle,
} from "../extensions/orchestration/index.ts";
import { createResources } from "../extensions/resources/index.ts";
import { createWorkspace } from "../extensions/workspace/index.ts";
import { renderCatalog } from "../models/catalog.ts";
import { createRoles } from "../roles/index.ts";
import { readText } from "../shared/fs.ts";
import type { EeveePaths } from "../shared/paths.ts";
import type { Settings } from "../shared/settings.ts";
import { JobHost } from "./jobs.ts";
import type { ProjectMeta } from "./project.ts";
import { entryText, recentLines, recentRounds, summarizeLine } from "./transcript.ts";

export class NotFound extends Error {
  override name = "NotFound";
}

export class Conflict extends Error {
  override name = "Conflict";
}

const ROLES = ["router", "worker", "dreamer"] as const;
const TICK_MS = 250;
const UPKEEP_MS = 5_000;
const RECENT_ROUNDS = 3;
const INITIAL_MEMORY = "# 项目记忆\n\n每个对话都需要知道的核心约定，以及指向主题笔记的索引。\n";
const INITIAL_GLOBAL_MEMORY = "# 全局记忆\n\n与用户本人有关的跨项目偏好，保持极短。\n";

export type ProjectHostOptions = {
  paths: EeveePaths;
  meta: ProjectMeta;
  models: () => Models;
  settings: () => Settings;
  globalMemory: MemoryRepo;
  context: Context;
  credentials?: Pick<CredentialStore, "list">;
  upkeepMs?: number;
};

export class ProjectHost {
  readonly meta: ProjectMeta;
  readonly #harness: Harness;
  readonly #root: Conversation;
  readonly #jobs: JobHost;
  readonly #models: () => Models;
  readonly #settings: () => Settings;
  readonly #context: Context;
  readonly #timer: NodeJS.Timeout;
  #ticking = false;
  #lastUpkeep = 0;
  readonly #upkeepMs: number;

  private constructor(parts: {
    meta: ProjectMeta;
    harness: Harness;
    root: Conversation;
    jobs: JobHost;
    models: () => Models;
    settings: () => Settings;
    context: Context;
    upkeepMs: number;
  }) {
    this.meta = parts.meta;
    this.#harness = parts.harness;
    this.#root = parts.root;
    this.#jobs = parts.jobs;
    this.#models = parts.models;
    this.#settings = parts.settings;
    this.#context = parts.context;
    this.#upkeepMs = parts.upkeepMs;
    this.#timer = setInterval(() => void this.#tick(), TICK_MS);
    this.#timer.unref();
    void this.#tick();
  }

  static async open(options: ProjectHostOptions): Promise<ProjectHost> {
    const { meta, context } = options;
    const projectPaths = options.paths.project(meta.id);
    const projectMemory = new MemoryRepo(projectPaths.memory);
    await projectMemory.ensure(INITIAL_MEMORY);
    await options.globalMemory.ensure(INITIAL_GLOBAL_MEMORY);
    const repos = { project: projectMemory, global: options.globalMemory };

    let harness: Harness | undefined;
    let delivery: DeliveryContext | undefined;
    const requireHarness = () => {
      if (harness === undefined) throw new Error("Harness 尚未打开");
      return harness;
    };
    const jobLog = (id: string) => join(projectPaths.jobs, `${id}.log`);
    const jobs = new JobHost({
      logPath: jobLog,
      delivery: () => {
        if (delivery === undefined) throw new Error("Harness 尚未打开");
        return delivery;
      },
      context,
    });

    const roles = createRoles({
      project: { title: meta.title, workspace: meta.workspace },
      memory: async () => ({
        global: (await repos.global.read("MEMORY.md")) ?? "",
        project: (await repos.project.read("MEMORY.md")) ?? "",
      }),
      defaultModel: (role) => pickModel(role, meta.models, options.settings().models),
      recent: async (conversationId, ctx) => {
        const conversation = await requireHarness().conversation(conversationId, ctx);
        return conversation === undefined ? "" : recentRounds(conversation, RECENT_ROUNDS, ctx);
      },
    });

    const registry = createRegistry();
    registry.install(
      createResources({
        memoryDir: (scope) => repos[scope].dir,
        jobLog,
        models: async () =>
          renderCatalog({
            models: options.models(),
            ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
            defaults: Object.fromEntries(
              ROLES.map((role) => [role, pickModel(role, meta.models, options.settings().models)]),
            ),
            profiles: await readText(options.paths.modelProfiles),
          }),
        transcript: (conversationId, entryId, ctx) =>
          renderTranscript(requireHarness(), conversationId, entryId, ctx),
      }),
    );
    registry.install(
      createWorkspace({ backgroundAfterMs: () => options.settings().backgroundAfterMs, jobs }),
    );
    registry.install(createMemory({ repos }));
    registry.install(
      createOrchestration({
        conversations: roles.ticketConversations,
        handoff: {
          shouldHandoff: async (conversationId, ctx) => {
            const conversation = await requireHarness().conversation(conversationId, ctx);
            if (conversation === undefined) return false;
            return (
              (await contextFraction(conversation, options.models(), ctx)) >
              options.settings().handoffThreshold
            );
          },
        },
        jobs,
      }),
    );
    registry.install(roles.extension);

    harness = await Harness.open(
      await openNodeSqliteStorage(projectPaths.session),
      {
        models: options.models,
        registry,
        env: ({ cwd = meta.workspace }) => new NodeExecutionEnv({ cwd }),
        onReport: (report) => console.error(`[${meta.id}]`, report),
      },
      context,
    );

    const routerAgent = roles.routerAgent(registry.snapshot());
    const root = await harness.root(context, { agent: routerAgent });
    await root.configure(routerAgent, context);
    const first = await root.entries({}, 1, undefined, context);
    if (first.items.length === 0)
      await root.reset(await roles.routerOpening(harness, context), context);
    delivery = deliveryHost(harness, root);
    await flush(delivery, context);
    await jobs.recover();
    harness.resume();
    return new ProjectHost({
      meta,
      harness,
      root,
      jobs,
      models: options.models,
      settings: options.settings,
      context,
      upkeepMs: options.upkeepMs ?? UPKEEP_MS,
    });
  }

  async sendUserMessage(text: string): Promise<void> {
    await this.#dispatch({ type: "user-message", id: crypto.randomUUID(), text });
  }

  async answerQuestion(id: QuestionId, answer: string): Promise<void> {
    const question = await this.#harness.snapshot(QuestionDoc, id, this.#context);
    if (question === undefined) throw new NotFound(`没有问题 ${id}`);
    if (question.answer !== undefined) throw new Conflict(`${id} 已经回答过了`);
    const answered = { ...question, answer, answeredAt: Date.now() };
    await this.#dispatch({ type: "question-answered", question: answered }, async (tx) => {
      Object.assign(await tx.doc(QuestionDoc, id, answered), answered);
      const board = await tx.doc(Board);
      board.openQuestions = board.openQuestions.filter((q) => q !== id);
    });
  }

  async board(): Promise<BoardView> {
    const ctx = this.#context;
    const state = await this.#harness.snapshot(Board, ctx);
    const openQuestions = [];
    for (const id of state?.openQuestions ?? []) {
      const question = await this.#harness.snapshot(QuestionDoc, id, ctx);
      if (question) openQuestions.push(question);
    }
    const queued = await queuedTickets(this.#harness, ctx);
    const tickets: TicketView[] = [];
    for (const id of (state?.tickets ?? []) as TicketId[]) {
      const ticket = await this.#harness.snapshot(TicketDoc, id, ctx);
      if (ticket === undefined) continue;
      const reports = [...((await this.#harness.snapshot(ReportLog, id, ctx))?.reports ?? [])];
      const live = await this.#harness.snapshot(LiveDoc, conversationOf(ticket), ctx);
      const stage = deriveStage({
        openQuestion: openQuestions.some((q) => q.ticketId === id),
        reports,
        queued: queued.has(id),
        running: live?.run !== undefined,
        jobsRunning: this.#jobs.running(id).length > 0,
      });
      tickets.push({ ticket, stage, reports });
    }
    return { tickets, openQuestions };
  }

  async conversation(limit = 100): Promise<ConversationView> {
    return this.#view(this.#root, limit);
  }

  async retry(ticketId?: TicketId): Promise<void> {
    const conversation = ticketId === undefined ? this.#root : await this.#worker(ticketId);
    if (ticketId !== undefined) await this.#openTicket(ticketId);
    const live = await this.#harness.snapshot(LiveDoc, conversation.id, this.#context);
    if (live?.run !== undefined) throw new Conflict("对话正在运行");
    if (live?.runFailure === undefined) throw new Conflict("上一轮没有失败，不需要重试");
    await conversation.submit({ type: "continue" }, this.#context);
  }

  async #view(conversation: Conversation, limit: number): Promise<ConversationView> {
    const live = await this.#harness.snapshot(LiveDoc, conversation.id, this.#context);
    const failure = live?.run === undefined ? live?.runFailure : undefined;
    return {
      lines: await recentLines(conversation, limit, this.#context),
      running: live?.run !== undefined,
      ...(failure === undefined ? {} : { failure: describeFailure(failure) }),
    };
  }

  async refreshRouterModel(): Promise<void> {
    const model = pickModel("router", this.meta.models, this.#settings().models);
    if (model !== undefined) await this.#root.configure({ model }, this.#context);
  }

  async ticketConversation(id: TicketId, limit = 200): Promise<ConversationView> {
    return this.#view(await this.#worker(id), limit);
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
    const worker = await this.#worker(id);
    await this.#openTicket(id);
    await worker.abort(this.#context);
    await this.#dispatch({ type: "panel-interrupt", id: crypto.randomUUID(), ticketId: id });
  }

  async #openTicket(id: TicketId) {
    const ticket = await this.#harness.snapshot(TicketDoc, id, this.#context);
    if (ticket === undefined) throw new NotFound(`没有工单 ${id}`);
    if (ticket.status !== "open") throw new Conflict(`${id} 已经结单`);
    return ticket;
  }

  async #worker(id: TicketId): Promise<Conversation> {
    const ticket = await this.#harness.snapshot(TicketDoc, id, this.#context);
    if (ticket === undefined) throw new NotFound(`没有工单 ${id}`);
    const conversation = await this.#harness.conversation(conversationOf(ticket), this.#context);
    if (conversation === undefined) throw new NotFound(`找不到 ${id} 的执行对话`);
    return conversation;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.#jobs.close();
    await this.#harness.close(this.#context);
  }

  async #tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const host = deliveryHost(this.#harness, this.#root);
      const settings = this.#settings();
      await pump(host, settings.maxActiveWorkers, this.#context);
      const now = Date.now();
      if (now - this.#lastUpkeep >= this.#upkeepMs) {
        this.#lastUpkeep = now;
        await remindRouter(host, { olderThan: settings.reminderAfterMs, now }, this.#context);
        await this.#nudgeHandoff(host, settings.handoffThreshold);
      }
    } catch (error) {
      console.error(`[${this.meta.id}] 调度出错`, error);
    } finally {
      this.#ticking = false;
    }
  }

  async #nudgeHandoff(host: DeliveryContext, threshold: number): Promise<void> {
    if (!(await routerIdle(host, this.#context))) return;
    const fraction = await contextFraction(this.#root, this.#models(), this.#context);
    if (fraction <= threshold) return;
    const { epoch } = await contextUsage(this.#root, this.#context);
    await this.#dispatch({ type: "handoff-nudge", epoch });
  }

  async #dispatch(event: EngineEvent, change?: (tx: Tx) => Promise<void>): Promise<void> {
    await deliver(deliveryHost(this.#harness, this.#root), route(event), this.#context, change);
  }
}

const FAILURE_LABEL: Record<string, string> = {
  model_error: "模型调用失败",
  no_model: "没有配置模型",
  aborted: "已中止",
  interrupted: "运行被中断",
  turn_limit: "超出轮次上限",
  restart_limit: "多次重启后放弃",
};

function describeFailure(failure: { reason: string; detail?: unknown }): string {
  const label = FAILURE_LABEL[failure.reason] ?? failure.reason;
  return failure.detail === undefined ? label : `${label}：${String(failure.detail)}`;
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

async function renderTranscript(
  harness: Harness,
  conversationId: number,
  entryId: number | undefined,
  context: Context,
): Promise<string | undefined> {
  const conversation = await harness.conversation(conversationId as ConversationId, context);
  if (conversation === undefined) return undefined;
  if (entryId !== undefined) return entryText(conversation, entryId, context);
  const lines = await recentLines(conversation, 20, context);
  return lines.map((line) => summarizeLine(line)).join("\n");
}
