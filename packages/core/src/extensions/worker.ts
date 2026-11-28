import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  type Cursor,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  hook,
  hookTask,
  InboxDoc,
  ROOT_CONVERSATION_ID,
  section,
  type TaskRuntime,
  type ToolExecutionResult,
  wrapSection,
} from "@earendil-works/pi-durable";
import { lit, obj, opt, str } from "@earendil-works/pi-schema";
import { isTaskActiveStatus, TaskRecordDoc, TasksBoardDoc, withToolPromptMeta } from "@eevee/agent";
import { findWorkerByConversationInTx, NOTICE_ENTRY_KIND, type WorkerDocState } from "../docs.ts";
import { DEFAULT_WORKER_INSTRUCTIONS, WORKER_EXTENSION, WORKER_PREAMBLE } from "../roles.ts";

export const HANDOFF_TASK_NAME = "eevee.worker-handoff";
export const HANDOFF_MAX_CHARS = 4000;

export type WorkerHandoffInput = {
  readonly reason: "answer" | "terminate";
  readonly first: EntryId;
  readonly answer: EntryId;
  readonly last: EntryId;
};

type HandoffCheckpoint = {
  phase: "deliver";
};

type MessageRouterCommit =
  | {
      readonly workerId: WorkerDocState["id"];
      readonly ticketId?: WorkerDocState["activeTicketId"];
    }
  | { readonly error: string };

const EXCLUDED_TOOL_ROUND_STOP_REASONS = new Set(["aborted", "error", "deferred"]);

function answerTextOf(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") return "";
  return contentText(message.content).trim();
}

function errorResult(message: string): ToolExecutionResult {
  return {
    output: [{ type: "text", text: message }],
    isError: true,
  };
}

async function lastToolCallingAssistant(
  runtime: TaskRuntime<WorkerHandoffInput, HandoffCheckpoint, null, object>,
  input: WorkerHandoffInput,
  context: Context,
): Promise<AssistantMessage | undefined> {
  let cursor: Cursor | undefined;
  let last: AssistantMessage | undefined;
  do {
    const page = await runtime.entries(
      {
        minEntryId: input.first,
        maxEntryId: input.last,
        order: "ascending",
      },
      500,
      cursor,
      context,
    );
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant") continue;
        if (EXCLUDED_TOOL_ROUND_STOP_REASONS.has(message.stopReason)) continue;
        if (message.content.some((block) => block.type === "toolCall")) last = message;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return last;
}

export function createWorkerHandoffTask() {
  return defineTask<WorkerHandoffInput, HandoffCheckpoint, null>({
    name: HANDOFF_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        const answerEntry = await runtime.entry(task.input.answer, context);
        const root = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        const lastToolCall = await lastToolCallingAssistant(runtime, task.input, context);
        const routerAlreadyMessaged =
          lastToolCall?.content.some(
            (block) => block.type === "toolCall" && block.name === "message_router",
          ) === true;
        const fullAnswer = answerTextOf(answerEntry);
        const truncated = fullAnswer.length > HANDOFF_MAX_CHARS;
        const answer = truncated ? fullAnswer.slice(0, HANDOFF_MAX_CHARS) : fullAnswer;

        await runtime.commit(async (tx) => {
          const terminal = {
            status: "terminal",
            outcome: { status: "completed", result: null },
          } as const;
          if (root === undefined) return terminal;

          const tasksBoard = await tx.doc(TasksBoardDoc, runtime.conversationId);
          for (const taskId of tasksBoard.order) {
            const record = await tx.doc(TaskRecordDoc, runtime.conversationId, taskId, null);
            if (isTaskActiveStatus(record.status)) return terminal;
          }

          const inbox = await tx.doc(InboxDoc, runtime.conversationId);
          if (inbox.items.some((item) => item.mode === "steer" || item.mode === "followUp")) {
            return terminal;
          }

          const worker = await findWorkerByConversationInTx(tx, runtime.conversationId);
          if (worker === undefined || worker.closedAt !== undefined) return terminal;
          if (routerAlreadyMessaged) return terminal;

          const ticketId = worker.activeTicketId;
          const truncationHint = truncated
            ? `\n\n[Answer truncated to ${HANDOFF_MAX_CHARS} characters. Use inspect_worker({ workerId: "${worker.id}" }) to read the full reply.]`
            : "";
          const text = answer.length === 0 ? "(empty final reply)" : answer;
          await root.admit(tx, {
            type: "input",
            content: `Worker ${worker.name} (${worker.id}) finished:\n\n${text}${truncationHint}`,
            whenBusy: "followUp",
            onAbort: "keep",
            requestId: `eevee.handoff:${task.input.answer}`,
            entry: {
              kind: NOTICE_ENTRY_KIND,
              data: {
                type: "handoff",
                workerId: worker.id,
                workerName: worker.name,
                ...(ticketId === undefined ? {} : { ticketId }),
                answerEntryId: task.input.answer,
              },
            },
          });
          return terminal;
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        async () =>
          ({
            status: "terminal",
            outcome: { status: "aborted" },
          }) as const,
        context,
      );
    },
  });
}

export type WorkerExtensionDeps = {
  readonly projectMemory?: () => string | undefined;
  readonly workerInstructions?: string;
};

export function createWorkerExtension(deps: WorkerExtensionDeps = {}) {
  const handoffTask = createWorkerHandoffTask();
  const messageRouter = withToolPromptMeta(
    defineTool({
      name: "message_router",
      description:
        "Send a progress update, question, or conclusion to the Router and return immediately. Use this instead of waiting for the automatic end-of-run handoff when the Router should act now.",
      parameters: obj({
        message: str({ minLength: 1, description: "Message for the Router" }),
      }),
      structuredOutputSchema: obj({
        delivered: lit(true),
        workerId: str(),
        ticketId: opt(str()),
      }),
      execute: async (args, api, context): Promise<ToolExecutionResult> => {
        const router = await api.conversation(ROOT_CONVERSATION_ID, context);
        if (router === undefined) return errorResult("The Router conversation is unavailable.");
        const delivered = await api.commit(async (tx): Promise<MessageRouterCommit> => {
          const worker = await findWorkerByConversationInTx(tx, api.conversationId);
          if (worker === undefined) {
            return { error: "This conversation is not registered as a Worker." };
          }
          if (worker.closedAt !== undefined) {
            return { error: `Worker ${worker.id} is closed.` };
          }
          const ticketId = worker.activeTicketId;
          await router.admit(tx, {
            type: "input",
            content: `Worker ${worker.name} (${worker.id}) sent a message:\n\n${args.message}`,
            whenBusy: "followUp",
            onAbort: "keep",
            requestId: `eevee.message-router:${api.taskId}`,
            entry: {
              kind: NOTICE_ENTRY_KIND,
              data: {
                type: "worker_message",
                workerId: worker.id,
                workerName: worker.name,
                ...(ticketId === undefined ? {} : { ticketId }),
              },
            },
          });
          return {
            workerId: worker.id,
            ...(ticketId === undefined ? {} : { ticketId }),
          };
        }, context);
        if ("error" in delivered) return errorResult(delivered.error);
        return {
          output: [{ type: "text", text: "Delivered to the Router." }],
          structuredOutput: {
            delivered: true,
            workerId: delivered.workerId,
            ...(delivered.ticketId === undefined ? {} : { ticketId: delivered.ticketId }),
          },
        };
      },
    }),
    {
      promptSnippet: "Send a progress update, question, or conclusion to the Router",
      promptGuidelines: [
        "Use message_router to send progress updates, ask the Router for missing decisions or information, or report conclusions immediately without waiting for run completion.",
      ],
    },
  );

  const workerRoleSection = section("worker-role", () => {
    const text = (deps.workerInstructions ?? DEFAULT_WORKER_INSTRUCTIONS).trim();
    return text ? text : undefined;
  });

  const projectMemorySection = section("project-memory", () => {
    const text = deps.projectMemory?.()?.trim();
    return text ? text : undefined;
  });

  return defineExtension({
    name: WORKER_EXTENSION,
    tools: [messageRouter],
    sections: [workerRoleSection, projectMemorySection],
    wraps: [
      wrapSection("preamble", (base) => ({
        ...base,
        render: () => WORKER_PREAMBLE,
      })),
    ],
    tasks: [handoffTask],
    hooks: [
      hook(GenerationTask, {
        afterRun: (run) => ({ tasks: [hookTask(handoffTask, run)] }),
      }),
    ],
  });
}
