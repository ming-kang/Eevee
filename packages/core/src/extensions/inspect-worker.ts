import type { Context } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineTool,
  type EntryRecord,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { arr, bool, int, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  type BackgroundTaskRecord,
  describeTaskOutcome,
  formatSize,
  listConversationTasks,
  MAX_FILTER_SCAN_BYTES,
  TASK_FILTER_MAX_CONTEXT_LINES,
  type TaskManager,
  withToolPromptMeta,
} from "@eevee/agent";
import { readWorker, type WorkerId } from "../docs.ts";
import { ProjectError } from "../errors.ts";
import { formatBoardOverview, readBoardView } from "../views.ts";
import { resolveWorkerTask } from "../worker-ops.ts";

export type InspectWorkerDeps = {
  readonly tasks: TaskManager;
  readEntries(
    conversationId: ConversationId,
    limit: number,
    context: Context,
  ): Promise<readonly EntryRecord[]>;
};

const DEFAULT_TRANSCRIPT_LIMIT = 20;
const MAX_TRANSCRIPT_LIMIT = 100;

function errorResult(message: string): ToolExecutionResult {
  return {
    output: [{ type: "text", text: message }],
    isError: true,
  };
}

function summarizeEntry(entry: EntryRecord): {
  readonly entryId: number;
  readonly kind: string;
  readonly role: string;
  readonly text: string;
} | null {
  const parts: string[] = [];
  let role = entry.kind;
  for (const message of entry.model ?? []) {
    if (message.role === "system") continue;
    role = message.role;
    if (message.role === "user") {
      const text = contentText(message.content).trim();
      if (text) parts.push(text);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
        if (block.type === "toolCall") {
          parts.push(`[toolCall: ${block.name}(${JSON.stringify(block.arguments)})]`);
        }
      }
    } else if (message.role === "toolResult") {
      const text = contentText(message.content).trim();
      parts.push(`[${message.toolName}${message.isError ? " error" : ""}] ${text}`);
    }
  }
  if (parts.length === 0) return null;
  return {
    entryId: entry.id,
    kind: entry.kind,
    role,
    text: parts.join("\n"),
  };
}

export function createInspectWorkerTool(deps: InspectWorkerDeps) {
  return withToolPromptMeta(
    defineTool({
      name: "inspect_worker",
      description:
        "Inspect project Workers, Tickets, and Questions. Omit workerId for a project board overview; pass workerId with include='summary' | 'transcript' | 'tasks' (and optional taskId to read background task output).",
      replay: "safe",
      parameters: obj({
        workerId: opt(str({ minLength: 1, description: "Worker id to inspect (e.g. w1)" })),
        include: opt(
          oneOf(["summary", "transcript", "tasks"], {
            description: "What to inspect for the Worker (default summary)",
          }),
        ),
        taskId: opt(
          str({ minLength: 1, description: "Background task id or prefix when include='tasks'" }),
        ),
        mode: opt(oneOf(["head", "tail"], { description: "Task output read mode (default tail)" })),
        bytes: opt(num({ description: "Max bytes of task output to read" })),
        sinceBytes: opt(num({ description: "Incremental byte cursor for task output" })),
        endByte: opt(
          num({ description: "Backward paging upper bound byte offset for task output" }),
        ),
        filter: opt(
          str({
            description:
              "Filter task output to matching lines (case-insensitive substring or /regex/flags)",
          }),
        ),
        contextLines: opt(
          int({
            minimum: 0,
            maximum: TASK_FILTER_MAX_CONTEXT_LINES,
            description: `Context lines around each filtered match, 0–${TASK_FILTER_MAX_CONTEXT_LINES} (requires filter)`,
          }),
        ),
        limit: opt(
          int({
            minimum: 1,
            maximum: MAX_TRANSCRIPT_LIMIT,
            description:
              "Number of recent transcript entries when include='transcript' (default 20)",
          }),
        ),
      }),
      structuredOutputSchema: obj(
        {
          scope: oneOf(["board", "summary", "transcript", "tasks", "task_output"]),
          workerId: opt(str()),
          status: opt(str()),
          workers: opt(
            arr(
              obj(
                {
                  id: str(),
                  name: str(),
                  cwd: str(),
                  status: str(),
                  activeTicketId: opt(str()),
                  activeTaskCount: int({ minimum: 0 }),
                },
                { open: true },
              ),
            ),
          ),
          tickets: opt(
            arr(
              obj(
                {
                  id: str(),
                  workerId: str(),
                  title: str(),
                  status: str(),
                  note: opt(str()),
                },
                { open: true },
              ),
            ),
          ),
          questions: opt(
            arr(
              obj(
                {
                  id: str(),
                  answered: bool(),
                  count: int({ minimum: 0 }),
                },
                { open: true },
              ),
            ),
          ),
          entries: opt(
            arr(
              obj(
                {
                  entryId: num(),
                  kind: str(),
                  role: str(),
                  text: str(),
                },
                { open: true },
              ),
            ),
          ),
          tasks: opt(
            arr(
              obj(
                {
                  id: str(),
                  command: str(),
                  status: str(),
                  exitCode: opt(num()),
                  error: opt(str()),
                },
                { open: true },
              ),
            ),
          ),
          taskId: opt(str()),
          command: opt(str()),
          output: opt(str()),
          fromByte: opt(num()),
          endByte: opt(num()),
          totalBytes: opt(num()),
          truncated: opt(bool()),
          matchedLines: opt(num()),
          totalMatchedLines: opt(num()),
          scanTruncated: opt(bool()),
        },
        { open: true },
      ),
      execute: async (args, api, context): Promise<ToolExecutionResult> => {
        if (args.workerId === undefined) {
          const board = await readBoardView(api, context);
          return {
            output: [{ type: "text", text: formatBoardOverview(board) }],
            structuredOutput: {
              scope: "board",
              workers: board.workers.map((worker) => ({
                id: worker.id,
                name: worker.name,
                cwd: worker.cwd,
                status: worker.status,
                ...(worker.activeTicketId === undefined
                  ? {}
                  : { activeTicketId: worker.activeTicketId }),
                activeTaskCount: worker.activeTaskCount,
              })),
              tickets: board.tickets.map((ticket) => ({
                id: ticket.id,
                workerId: ticket.workerId,
                title: ticket.title,
                status: ticket.status,
                ...(ticket.note === undefined ? {} : { note: ticket.note }),
              })),
              questions: board.questions.map((question) => ({
                id: question.id,
                answered: question.answeredAt !== undefined,
                count: question.items.length,
              })),
            },
          };
        }

        const workerId = args.workerId as WorkerId;
        const worker = await readWorker(api, workerId, context);
        if (worker === undefined) return errorResult(`Unknown worker ${workerId}.`);

        const include = args.include ?? "summary";
        if (include === "transcript") {
          const limit = args.limit ?? DEFAULT_TRANSCRIPT_LIMIT;
          const rawEntries = await deps.readEntries(worker.conversationId, limit, context);
          const formatted = rawEntries
            .map(summarizeEntry)
            .filter((item): item is NonNullable<typeof item> => item !== null);
          const text =
            formatted.length === 0
              ? `Worker ${workerId} (${worker.name}) has no transcript entries yet.`
              : formatted
                  .map((item) => `#${item.entryId} [${item.role}]\n${item.text}`)
                  .join("\n\n");
          return {
            output: [{ type: "text", text }],
            structuredOutput: {
              scope: "transcript",
              workerId,
              entries: formatted,
            },
          };
        }

        if (include === "tasks") {
          if (args.taskId !== undefined) {
            let record: BackgroundTaskRecord;
            try {
              ({ record } = await resolveWorkerTask(api, workerId, args.taskId, context));
            } catch (error) {
              if (error instanceof ProjectError) return errorResult(error.message);
              throw error;
            }
            let slice: Awaited<ReturnType<TaskManager["readOutput"]>>;
            try {
              slice = await deps.tasks.readOutput(worker.conversationId, record.id, record, {
                ...(args.mode === undefined ? {} : { mode: args.mode }),
                ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
                ...(args.sinceBytes === undefined ? {} : { sinceBytes: args.sinceBytes }),
                ...(args.endByte === undefined ? {} : { endByte: args.endByte }),
                ...(args.filter === undefined ? {} : { filter: args.filter }),
                ...(args.contextLines === undefined ? {} : { contextLines: args.contextLines }),
              });
            } catch (error) {
              return errorResult(error instanceof Error ? error.message : String(error));
            }
            const rangeSummary =
              args.filter !== undefined && args.filter !== ""
                ? `Matched ${slice.matchedLines ?? 0} of ${slice.totalMatchedLines ?? 0} lines in bytes ${slice.fromByte}..${slice.endByte} of ${slice.totalBytes}${slice.scanTruncated ? ` (scan capped at ${formatSize(MAX_FILTER_SCAN_BYTES)})` : ""}`
                : `Bytes ${slice.fromByte}..${slice.endByte} of ${slice.totalBytes}${slice.truncated ? " (truncated)" : ""}`;
            const header = `Worker ${workerId} task ${record.id} (${describeTaskOutcome(record)}) — ${record.command}\n${rangeSummary}`;
            return {
              output: [
                { type: "text", text: slice.text === "" ? header : `${header}\n\n${slice.text}` },
              ],
              structuredOutput: {
                scope: "task_output",
                workerId,
                taskId: record.id,
                command: record.command,
                status: record.status,
                output: slice.text,
                fromByte: slice.fromByte,
                endByte: slice.endByte,
                totalBytes: slice.totalBytes,
                truncated: slice.truncated,
                ...(slice.matchedLines === undefined ? {} : { matchedLines: slice.matchedLines }),
                ...(slice.totalMatchedLines === undefined
                  ? {}
                  : { totalMatchedLines: slice.totalMatchedLines }),
                ...(slice.scanTruncated === undefined
                  ? {}
                  : { scanTruncated: slice.scanTruncated }),
              },
            };
          }

          const tasks = await listConversationTasks(api, worker.conversationId, context);
          const lines =
            tasks.length === 0
              ? [`Worker ${workerId} (${worker.name}) has no background tasks.`]
              : [
                  `Background tasks on ${workerId} (${worker.name}):`,
                  ...tasks.map(
                    (task) => `- ${task.id} [${describeTaskOutcome(task)}]: ${task.command}`,
                  ),
                ];
          return {
            output: [{ type: "text", text: lines.join("\n") }],
            structuredOutput: {
              scope: "tasks",
              workerId,
              tasks: tasks.map((task) => ({
                id: task.id,
                command: task.command,
                status: task.status,
                ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
                ...(task.error === undefined ? {} : { error: task.error }),
              })),
            },
          };
        }

        const board = await readBoardView(api, context);
        const item = board.workers.find((candidate) => candidate.id === workerId);
        if (item === undefined) return errorResult(`Unknown worker ${workerId}.`);
        const workerTickets = board.tickets.filter((ticket) => ticket.workerId === workerId);
        const lines = [
          `Worker ${item.id} "${item.name}" [${item.status}]`,
          `cwd: ${item.cwd}`,
          ...(item.model === undefined
            ? []
            : [
                `model: ${item.model.provider}/${item.model.modelId}${item.model.thinkingLevel === undefined ? "" : ` (${item.model.thinkingLevel})`}`,
              ]),
          `active background tasks: ${item.activeTaskCount} (total ${item.tasks.length})`,
          workerTickets.length === 0
            ? "tickets: none"
            : `tickets:\n${workerTickets
                .map(
                  (ticket) =>
                    `- ${ticket.id} [${ticket.status}] ${ticket.title}${ticket.note === undefined ? "" : ` — ${ticket.note}`}`,
                )
                .join("\n")}`,
        ];
        return {
          output: [{ type: "text", text: lines.join("\n") }],
          structuredOutput: {
            scope: "summary",
            workerId: item.id,
            status: item.status,
            tickets: workerTickets.map((ticket) => ({
              id: ticket.id,
              workerId: ticket.workerId,
              title: ticket.title,
              status: ticket.status,
              ...(ticket.note === undefined ? {} : { note: ticket.note }),
            })),
            tasks: item.tasks.map((task) => ({
              id: task.id,
              command: task.command,
              status: task.status,
              ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
              ...(task.error === undefined ? {} : { error: task.error }),
            })),
          },
        };
      },
    }),
    {
      promptSnippet: "Inspect Workers, Tickets, Questions, transcripts, and background task logs",
      promptGuidelines: [
        "Use inspect_worker to check board state, Worker summaries, recent transcripts, or background task output without interrupting the Worker.",
      ],
    },
  );
}
