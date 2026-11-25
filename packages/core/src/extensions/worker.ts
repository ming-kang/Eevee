import { contentText } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  hook,
  hookTask,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { TaskRecordDoc, TasksBoardDoc } from "@eevee/agent";
import { NOTICE_ENTRY_KIND, ProjectBoardDoc, WorkerDoc, type WorkerDocState } from "../docs.ts";
import { WORKER_EXTENSION } from "../roles.ts";

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

function answerTextOf(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") return "";
  return contentText(message.content).trim();
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
            if (record.status === "running") return terminal;
          }

          const board = await tx.doc(ProjectBoardDoc);
          let worker: WorkerDocState | undefined;
          for (const workerId of board.workerOrder) {
            const candidate = await tx.doc(WorkerDoc, workerId, null);
            if (candidate.conversationId === runtime.conversationId) {
              worker = { ...candidate };
              break;
            }
          }
          if (worker === undefined || worker.closedAt !== undefined) return terminal;

          const ticketId = worker.activeTicketId;
          const truncationHint = truncated
            ? `\n\n[Answer truncated to ${HANDOFF_MAX_CHARS} characters. Use inspect_worker({ workerId: "${worker.id}" }) to read the full reply.]`
            : "";
          const text = answer.length === 0 ? "(empty final reply)" : answer;
          await root.submit(tx, {
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

export function createWorkerExtension() {
  const handoffTask = createWorkerHandoffTask();
  return defineExtension({
    name: WORKER_EXTENSION,
    tasks: [handoffTask],
    hooks: [
      hook(GenerationTask, {
        afterRun: (run) => ({ tasks: [hookTask(handoffTask, run)] }),
      }),
    ],
  });
}
