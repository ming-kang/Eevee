import { resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type ToolExecutionResult,
  UserEntry,
} from "@earendil-works/pi-durable";
import { lit, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { ModelChoice } from "@eevee/agent";
import { ProjectBoardDoc, TicketDoc, type TicketId, WorkerDoc, type WorkerId } from "../docs.ts";
import {
  buildWorkerAgent,
  DEFAULT_WORKER_INSTRUCTIONS,
  parseModelSpec,
  ROUTER_EXTENSION,
} from "../roles.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RouterExtensionDeps = {
  readonly cwd: string;
  readonly workerModel?: ModelChoice;
  readonly workerInstructions?: string;
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
      let model = deps.workerModel;
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
        args.thinkingLevel ?? deps.workerModel?.thinkingLevel;
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

  return defineExtension({
    name: ROUTER_EXTENSION,
    tools: [spawnWorker],
  });
}
