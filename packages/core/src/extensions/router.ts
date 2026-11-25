import { basename, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type EntryRecord,
  section,
  type ToolExecutionResult,
  UserEntry,
} from "@earendil-works/pi-durable";
import { bool, lit, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type ModelChoice, TaskManager } from "@eevee/agent";
import {
  ProjectBoardDoc,
  readBoard,
  readTicket,
  readWorker,
  TicketDoc,
  type TicketId,
  WorkerDoc,
  type WorkerId,
} from "../docs.ts";
import {
  buildWorkerAgent,
  DEFAULT_WORKER_INSTRUCTIONS,
  parseModelSpec,
  ROUTER_EXTENSION,
} from "../roles.ts";
import { resolveWorkerStatus } from "../status.ts";
import { formatBoardOverview, readBoardView } from "../views.ts";
import { createAskUserTool } from "./ask-user.ts";
import { createInspectWorkerTool } from "./inspect-worker.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RouterProjectInfo = {
  readonly title: string;
  readonly workspaces: readonly string[];
};

export type RouterExtensionDeps = {
  readonly cwd: string;
  readonly workerModel?: ModelChoice | (() => ModelChoice | undefined);
  readonly workerInstructions?: string;
  readonly project?: () => RouterProjectInfo;
  readonly projectMemory?: () => string | undefined;
  readonly modelProfiles?: () => string | undefined | Promise<string | undefined>;
  readonly tasks?: TaskManager;
  readonly readEntries?: (
    conversationId: ConversationId,
    limit: number,
    context: Context,
  ) => Promise<readonly EntryRecord[]>;
};

export type SpawnWorkerResult = {
  readonly workerId: WorkerId;
  readonly ticketId: TicketId;
  readonly conversationId: ConversationId;
  readonly name: string;
  readonly cwd: string;
  readonly status: "queued";
};

function errorResult(message: string): ToolExecutionResult {
  return {
    output: [{ type: "text", text: message }],
    isError: true,
  };
}

export function createRouterExtension(deps: RouterExtensionDeps) {
  const spawnWorker = defineTool({
    name: "spawn_worker",
    description:
      "Create a reusable background Worker, give it its first ticket, and queue it to start. The Worker's final reply is handed back to you when it finishes.",
    parameters: obj({
      name: str({ minLength: 1, description: "Short human-readable Worker name" }),
      prompt: str({
        minLength: 1,
        description: "Complete initial user prompt for the Worker",
      }),
      cwd: opt(
        str({
          minLength: 1,
          description: "Worker workspace directory; relative paths resolve from the project root",
        }),
      ),
      model: opt(str({ description: "Model override as provider/model-id" })),
      thinkingLevel: opt(oneOf(THINKING_LEVELS, { description: "Thinking level override" })),
      ticketTitle: opt(str({ minLength: 1, description: "Ticket title; defaults to name" })),
    }),
    structuredOutputSchema: obj({
      workerId: str(),
      ticketId: str(),
      conversationId: num(),
      name: str(),
      cwd: str(),
      status: lit("queued"),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const defaultWorkerModel =
        typeof deps.workerModel === "function" ? deps.workerModel() : deps.workerModel;
      let model = defaultWorkerModel;
      if (args.model !== undefined) {
        model = parseModelSpec(args.model, api.models);
        if (model === undefined) {
          return errorResult(
            `Unknown model ${args.model}; use provider/model-id from the catalog.`,
          );
        }
      }
      const cwd = resolve(deps.cwd, args.cwd ?? ".");
      const thinkingLevel: ModelThinkingLevel | undefined =
        args.thinkingLevel ?? defaultWorkerModel?.thinkingLevel;
      const effectiveModel =
        model === undefined
          ? undefined
          : { ...model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
      const created = await api.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const workerAgent = buildWorkerAgent({
          snapshot: api.registry,
          ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          instructions: deps.workerInstructions ?? DEFAULT_WORKER_INSTRUCTIONS,
          cwd,
        });
        await configure(tx, conversation.id, workerAgent);
        await tx.appendEntry(UserEntry, conversation.id, {
          model: [{ role: "user", content: args.prompt, timestamp: api.now() }],
        });

        const board = await tx.doc(ProjectBoardDoc);
        const workerId = `w${board.nextWorkerSeq}` as WorkerId;
        const ticketId = `t${board.nextTicketSeq}` as TicketId;
        board.nextWorkerSeq += 1;
        board.nextTicketSeq += 1;
        board.workerOrder.push(workerId);
        board.ticketOrder.push(ticketId);

        const now = api.now();
        const worker = await tx.doc(WorkerDoc, workerId, null);
        worker.id = workerId;
        worker.name = args.name;
        worker.cwd = cwd;
        worker.conversationId = conversation.id;
        if (effectiveModel !== undefined) worker.model = effectiveModel;
        worker.activeTicketId = ticketId;
        worker.createdAt = now;

        const ticket = await tx.doc(TicketDoc, ticketId, null);
        ticket.id = ticketId;
        ticket.workerId = workerId;
        ticket.title = args.ticketTitle ?? args.name;
        ticket.status = "open";
        ticket.createdAt = now;

        board.pendingStarts.push({
          workerId,
          requestId: `eevee.worker.start:${workerId}`,
        });
        return {
          workerId,
          ticketId,
          conversationId: conversation.id,
          name: args.name,
          cwd,
          status: "queued" as const,
        };
      }, context);

      return {
        output: [
          {
            type: "text",
            text: `Queued ${created.workerId} (${created.name}) with ticket ${created.ticketId}. It will start when a Worker slot is free.`,
          },
        ],
        structuredOutput: created,
      };
    },
  });

  const messageWorker = defineTool({
    name: "message_worker",
    description:
      "Send a message to an existing Worker. Optionally steer an active run, change model/thinking settings, or attach a new ticket when the Worker has no open ticket.",
    parameters: obj({
      workerId: str({ minLength: 1, description: "Target Worker id (e.g. w1)" }),
      message: str({ minLength: 1, description: "Message text for the Worker" }),
      mode: opt(
        oneOf(["followUp", "steer"], {
          description: "Delivery mode if the Worker is busy (default followUp)",
        }),
      ),
      model: opt(str({ description: "Optional model override as provider/model-id" })),
      thinkingLevel: opt(oneOf(THINKING_LEVELS, { description: "Optional thinking level" })),
      newTicket: opt(
        obj({
          title: str({ minLength: 1, description: "Title for the new ticket" }),
        }),
      ),
    }),
    structuredOutputSchema: obj({
      workerId: str(),
      delivered: lit(true),
      queued: bool(),
      ticketId: opt(str()),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const workerId = args.workerId as WorkerId;
      let parsedModel: ModelChoice | undefined;
      if (args.model !== undefined) {
        parsedModel = parseModelSpec(args.model, api.models);
        if (parsedModel === undefined) {
          return errorResult(
            `Unknown model ${args.model}; use provider/model-id from the catalog.`,
          );
        }
      }

      const existing = await readWorker(api, workerId, context);
      if (existing === undefined) return errorResult(`Unknown worker ${workerId}.`);
      if (existing.closedAt !== undefined) return errorResult(`Worker ${workerId} is closed.`);
      const conversation = await api.conversation(existing.conversationId, context);
      if (conversation === undefined) {
        return errorResult(`Worker ${workerId} conversation is unavailable.`);
      }

      type CommitOutcome =
        | { readonly error: string }
        | {
            readonly workerId: WorkerId;
            readonly queued: boolean;
            readonly ticketId?: TicketId;
          };

      const outcome = await api.commit(async (tx): Promise<CommitOutcome> => {
        const board = await tx.doc(ProjectBoardDoc);
        if (!board.workerOrder.includes(workerId)) {
          return { error: `Unknown worker ${workerId}.` };
        }
        const worker = await tx.doc(WorkerDoc, workerId, null);
        if (worker.closedAt !== undefined) {
          return { error: `Worker ${workerId} is closed.` };
        }
        if (args.newTicket !== undefined && worker.activeTicketId !== undefined) {
          const activeTicket = await tx.doc(TicketDoc, worker.activeTicketId, null);
          if (activeTicket.status === "open") {
            return {
              error: `Worker ${workerId} already has open ticket ${worker.activeTicketId}; close it with close_ticket first.`,
            };
          }
        }

        const queued = board.pendingStarts.some((start) => start.workerId === workerId);
        const requestId = `eevee.message-worker:${api.taskId}`;
        if (queued) {
          await conversation.submit(tx, {
            type: "write",
            requestId,
            entry: {
              kind: UserEntry.kind,
              model: [{ role: "user", content: args.message, timestamp: api.now() }],
            },
          });
        } else {
          await conversation.submit(tx, {
            type: "input",
            content: args.message,
            whenBusy: args.mode ?? "followUp",
            onAbort: "keep",
            requestId,
          });
        }

        if (parsedModel !== undefined || args.thinkingLevel !== undefined) {
          const nextThinking = args.thinkingLevel ?? worker.model?.thinkingLevel;
          const nextModel =
            parsedModel !== undefined
              ? {
                  ...parsedModel,
                  ...(nextThinking === undefined ? {} : { thinkingLevel: nextThinking }),
                }
              : worker.model !== undefined
                ? {
                    ...worker.model,
                    ...(nextThinking === undefined ? {} : { thinkingLevel: nextThinking }),
                  }
                : undefined;
          if (nextModel !== undefined) worker.model = nextModel;
          await configure(tx, worker.conversationId, {
            ...(parsedModel === undefined
              ? {}
              : { model: { provider: parsedModel.provider, modelId: parsedModel.modelId } }),
            ...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }),
          });
        }

        let createdTicketId: TicketId | undefined;
        if (args.newTicket !== undefined) {
          createdTicketId = `t${board.nextTicketSeq}` as TicketId;
          board.nextTicketSeq += 1;
          board.ticketOrder.push(createdTicketId);
          const ticket = await tx.doc(TicketDoc, createdTicketId, null);
          ticket.id = createdTicketId;
          ticket.workerId = workerId;
          ticket.title = args.newTicket.title;
          ticket.status = "open";
          ticket.createdAt = api.now();
          worker.activeTicketId = createdTicketId;
        }

        return {
          workerId,
          queued,
          ...(createdTicketId === undefined ? {} : { ticketId: createdTicketId }),
        };
      }, context);

      if ("error" in outcome) return errorResult(outcome.error);
      const suffix = outcome.ticketId === undefined ? "" : ` with new ticket ${outcome.ticketId}`;
      const delivery = outcome.queued
        ? `Appended message to queued worker ${outcome.workerId}${suffix}.`
        : `Delivered message to worker ${outcome.workerId}${suffix}.`;
      return {
        output: [{ type: "text", text: delivery }],
        structuredOutput: {
          workerId: outcome.workerId,
          delivered: true,
          queued: outcome.queued,
          ...(outcome.ticketId === undefined ? {} : { ticketId: outcome.ticketId }),
        },
      };
    },
  });

  const closeTicket = defineTool({
    name: "close_ticket",
    description:
      "Close an open ticket as done or cancelled. Set closeWorker to true to also stop and close the Worker.",
    parameters: obj({
      ticketId: str({ minLength: 1, description: "Ticket id to close (e.g. t1)" }),
      status: oneOf(["done", "cancelled"], { description: "Final ticket status" }),
      note: opt(str({ description: "Optional closing note" })),
      closeWorker: opt(bool({ description: "Also close the Worker and abort its tasks" })),
    }),
    structuredOutputSchema: obj({
      ticketId: str(),
      workerId: str(),
      status: oneOf(["done", "cancelled"]),
      note: opt(str()),
      workerClosed: bool(),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const ticketId = args.ticketId as TicketId;
      const existing = await readTicket(api, ticketId, context);
      if (existing === undefined) return errorResult(`Unknown ticket ${ticketId}.`);
      if (existing.status !== "open") {
        return errorResult(`Ticket ${ticketId} is already ${existing.status}.`);
      }

      const workerSnapshot = await readWorker(api, existing.workerId, context);
      const workerConv =
        args.closeWorker === true && workerSnapshot !== undefined
          ? await api.conversation(workerSnapshot.conversationId, context)
          : undefined;

      type CloseOutcome =
        | { readonly error: string }
        | {
            readonly ticketId: TicketId;
            readonly workerId: WorkerId;
            readonly status: "done" | "cancelled";
            readonly note?: string;
            readonly workerClosed: boolean;
          };

      const outcome = await api.commit(async (tx): Promise<CloseOutcome> => {
        const board = await tx.doc(ProjectBoardDoc);
        if (!board.ticketOrder.includes(ticketId)) {
          return { error: `Unknown ticket ${ticketId}.` };
        }
        const ticket = await tx.doc(TicketDoc, ticketId, null);
        if (ticket.status !== "open") {
          return { error: `Ticket ${ticketId} is already ${ticket.status}.` };
        }
        const now = api.now();
        ticket.status = args.status;
        ticket.closedAt = now;
        if (args.note !== undefined) ticket.note = args.note;

        const workerId = ticket.workerId;
        let workerClosed = false;
        if (board.workerOrder.includes(workerId)) {
          const worker = await tx.doc(WorkerDoc, workerId, null);
          if (worker.activeTicketId === ticketId) delete worker.activeTicketId;
          if (args.closeWorker === true) {
            if (worker.closedAt === undefined) worker.closedAt = now;
            const kept = board.pendingStarts.filter((start) => start.workerId !== workerId);
            board.pendingStarts.splice(0, board.pendingStarts.length, ...kept);
            workerClosed = true;
          } else {
            workerClosed = worker.closedAt !== undefined;
          }
        }
        return {
          ticketId,
          workerId,
          status: args.status,
          ...(args.note === undefined ? {} : { note: args.note }),
          workerClosed,
        };
      }, context);

      if ("error" in outcome) return errorResult(outcome.error);
      if (args.closeWorker === true && workerConv !== undefined) {
        await workerConv.abort(context, { background: true });
      }
      const text = outcome.workerClosed
        ? `Closed ticket ${outcome.ticketId} as ${outcome.status} and closed worker ${outcome.workerId}.`
        : `Closed ticket ${outcome.ticketId} as ${outcome.status}. Worker ${outcome.workerId} remains available.`;
      return {
        output: [{ type: "text", text }],
        structuredOutput: outcome,
      };
    },
  });

  const stopWorker = defineTool({
    name: "stop_worker",
    description:
      "Interrupt a Worker's current run (preserving background tasks and keeping the Worker open) or close the Worker (killing background tasks and cancelling any open ticket).",
    parameters: obj({
      workerId: str({ minLength: 1, description: "Target Worker id (e.g. w1)" }),
      action: oneOf(["interrupt", "close"], {
        description: "interrupt stops only the active run; close terminates everything permanently",
      }),
      note: opt(str({ description: "Optional note applied if an open ticket is cancelled" })),
    }),
    structuredOutputSchema: obj({
      workerId: str(),
      action: oneOf(["interrupt", "close"]),
      status: oneOf(["queued", "running", "idle", "closed"]),
      cancelledTicketId: opt(str()),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const workerId = args.workerId as WorkerId;
      const existing = await readWorker(api, workerId, context);
      if (existing === undefined) return errorResult(`Unknown worker ${workerId}.`);
      if (existing.closedAt !== undefined) {
        return errorResult(`Worker ${workerId} is already closed.`);
      }
      const workerConv = await api.conversation(existing.conversationId, context);
      if (workerConv === undefined) {
        return errorResult(`Worker ${workerId} conversation is unavailable.`);
      }

      if (args.action === "interrupt") {
        await workerConv.abort(context);
        const [board, refreshed] = await Promise.all([
          readBoard(api, context),
          readWorker(api, workerId, context),
        ]);
        const pendingIds = board?.pendingStarts.map((start) => start.workerId) ?? [];
        const status =
          refreshed === undefined
            ? "closed"
            : await resolveWorkerStatus(api, refreshed, pendingIds, context);
        return {
          output: [{ type: "text", text: `Interrupted worker ${workerId} (status: ${status}).` }],
          structuredOutput: { workerId, action: "interrupt", status },
        };
      }

      type StopCloseOutcome =
        | { readonly error: string }
        | { readonly workerId: WorkerId; readonly cancelledTicketId?: TicketId };

      const closed = await api.commit(async (tx): Promise<StopCloseOutcome> => {
        const board = await tx.doc(ProjectBoardDoc);
        if (!board.workerOrder.includes(workerId)) {
          return { error: `Unknown worker ${workerId}.` };
        }
        const worker = await tx.doc(WorkerDoc, workerId, null);
        if (worker.closedAt !== undefined) {
          return { error: `Worker ${workerId} is already closed.` };
        }
        const now = api.now();
        worker.closedAt = now;
        const kept = board.pendingStarts.filter((start) => start.workerId !== workerId);
        board.pendingStarts.splice(0, board.pendingStarts.length, ...kept);

        let cancelledTicketId: TicketId | undefined;
        if (
          worker.activeTicketId !== undefined &&
          board.ticketOrder.includes(worker.activeTicketId)
        ) {
          const ticket = await tx.doc(TicketDoc, worker.activeTicketId, null);
          if (ticket.status === "open") {
            ticket.status = "cancelled";
            ticket.closedAt = now;
            if (args.note !== undefined) ticket.note = args.note;
            cancelledTicketId = ticket.id;
          }
          delete worker.activeTicketId;
        }
        return {
          workerId,
          ...(cancelledTicketId === undefined ? {} : { cancelledTicketId }),
        };
      }, context);

      if ("error" in closed) return errorResult(closed.error);
      await workerConv.abort(context, { background: true });
      const suffix =
        closed.cancelledTicketId === undefined
          ? ""
          : ` and cancelled ticket ${closed.cancelledTicketId}`;
      return {
        output: [{ type: "text", text: `Closed worker ${workerId}${suffix}.` }],
        structuredOutput: {
          workerId,
          action: "close",
          status: "closed",
          ...(closed.cancelledTicketId === undefined
            ? {}
            : { cancelledTicketId: closed.cancelledTicketId }),
        },
      };
    },
  });

  const askUser = createAskUserTool();
  const inspectWorker = createInspectWorkerTool({
    tasks: deps.tasks ?? new TaskManager(),
    readEntries: deps.readEntries ?? (async () => []),
  });

  const projectSection = section("project", () => {
    const info = deps.project?.() ?? {
      title: basename(deps.cwd) || deps.cwd,
      workspaces: [deps.cwd],
    };
    const dirs = info.workspaces.length > 0 ? info.workspaces : [deps.cwd];
    return [`Project: ${info.title}`, "Workspaces:", ...dirs.map((dir) => `- ${dir}`)].join("\n");
  });

  const boardOverviewSection = section("board-overview", async (input, context) => {
    const view = await readBoardView(input.read, context);
    return formatBoardOverview(view);
  });

  const modelProfilesSection = section("model-profiles", async () => {
    const text = (await deps.modelProfiles?.())?.trim();
    return text ? text : undefined;
  });

  const projectMemorySection = section("project-memory", () => {
    const text = deps.projectMemory?.()?.trim();
    return text ? text : undefined;
  });

  return defineExtension({
    name: ROUTER_EXTENSION,
    tools: [spawnWorker, messageWorker, closeTicket, stopWorker, inspectWorker, askUser],
    sections: [projectSection, boardOverviewSection, modelProfilesSection, projectMemorySection],
  });
}
