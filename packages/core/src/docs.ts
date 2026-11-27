import type { Context } from "@earendil-works/chord/context";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type DocumentReader,
  defineDoc,
  defineDocFamily,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ModelChoice } from "@eevee/agent";

export const NOTICE_ENTRY_KIND = "eevee.notice";

export type WorkerId = `w${number}`;
export type TicketId = `t${number}`;
export type QuestionId = `q${number}`;

export type WorkerStatus = "queued" | "running" | "idle" | "closed";
export type TicketStatus = "open" | "done" | "cancelled";

export type PendingStart = {
  workerId: WorkerId;
  requestId: string;
};

export type ProjectBoardState = {
  nextWorkerSeq: number;
  nextTicketSeq: number;
  nextQuestionSeq: number;
  workerOrder: WorkerId[];
  ticketOrder: TicketId[];
  questionOrder: QuestionId[];
  pendingStarts: PendingStart[];
};

export type WorkerDocState = {
  id: WorkerId;
  name: string;
  cwd: string;
  conversationId: ConversationId;
  model?: ModelChoice;
  activeTicketId?: TicketId;
  reportedFailure?: TaskId;
  createdAt: number;
  closedAt?: number;
};

export type TicketDocState = {
  id: TicketId;
  workerId: WorkerId;
  title: string;
  status: TicketStatus;
  note?: string;
  createdAt: number;
  closedAt?: number;
};

export type QuestionItem = {
  readonly question: string;
  readonly options?: string[];
  readonly recommended?: string;
};

export type QuestionDocState = {
  id: QuestionId;
  items: QuestionItem[];
  answers?: string[];
  askedAt: number;
  answeredAt?: number;
  withdrawnAt?: number;
};

export type WorkerRecord = WorkerDocState & {
  readonly status: WorkerStatus;
};
export type TicketRecord = TicketDocState;
export type QuestionRecord = QuestionDocState;

export const ProjectBoardDoc = defineDoc<ProjectBoardState>({
  kind: "eevee.project-board",
  version: 1,
  scope: "session",
  initial: () => ({
    nextWorkerSeq: 1,
    nextTicketSeq: 1,
    nextQuestionSeq: 1,
    workerOrder: [],
    ticketOrder: [],
    questionOrder: [],
    pendingStarts: [],
  }),
  checkpointWhen: () => true,
});

export const WorkerDoc = defineDocFamily<WorkerDocState, null>({
  kind: "eevee.worker",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({
    id: "w0" as WorkerId,
    name: "",
    cwd: "",
    conversationId: 0 as ConversationId,
    createdAt: 0,
  }),
  checkpointWhen: () => true,
});

export const TicketDoc = defineDocFamily<TicketDocState, null>({
  kind: "eevee.ticket",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({
    id: "t0" as TicketId,
    workerId: "w0" as WorkerId,
    title: "",
    status: "open",
    createdAt: 0,
  }),
  checkpointWhen: () => true,
});

export const QuestionDoc = defineDocFamily<QuestionDocState, null>({
  kind: "eevee.question",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({
    id: "q0" as QuestionId,
    items: [],
    askedAt: 0,
  }),
  checkpointWhen: () => true,
});

export type CompactionUsageState = {
  models: Record<string, JsonRepresentation<Usage>>;
};

export const CompactionUsageDoc = defineDoc<CompactionUsageState>({
  kind: "eevee.compaction-usage",
  version: 1,
  scope: "session",
  initial: () => ({ models: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export async function readBoard(
  reader: DocumentReader,
  context: Context,
): Promise<ProjectBoardState | undefined> {
  const board = await reader.snapshot(ProjectBoardDoc, context);
  return board === undefined ? undefined : { ...board };
}

export async function readWorker(
  reader: DocumentReader,
  workerId: WorkerId,
  context: Context,
): Promise<WorkerDocState | undefined> {
  const worker = await reader.snapshot(WorkerDoc, workerId, context);
  return worker === undefined ? undefined : { ...worker };
}

export async function readWorkers(
  reader: DocumentReader,
  context: Context,
  board?: ProjectBoardState,
): Promise<WorkerDocState[]> {
  const resolved = board ?? (await readBoard(reader, context));
  const order = resolved?.workerOrder;
  if (order === undefined || order.length === 0) return [];
  const workers = await Promise.all(order.map((workerId) => readWorker(reader, workerId, context)));
  return workers.filter((worker): worker is WorkerDocState => worker !== undefined);
}

export async function readTicket(
  reader: DocumentReader,
  ticketId: TicketId,
  context: Context,
): Promise<TicketDocState | undefined> {
  const ticket = await reader.snapshot(TicketDoc, ticketId, context);
  return ticket === undefined ? undefined : { ...ticket };
}

export async function readTickets(
  reader: DocumentReader,
  context: Context,
  board?: ProjectBoardState,
): Promise<TicketDocState[]> {
  const resolved = board ?? (await readBoard(reader, context));
  const order = resolved?.ticketOrder;
  if (order === undefined || order.length === 0) return [];
  const tickets = await Promise.all(order.map((ticketId) => readTicket(reader, ticketId, context)));
  return tickets.filter((ticket): ticket is TicketDocState => ticket !== undefined);
}

export async function readQuestion(
  reader: DocumentReader,
  questionId: QuestionId,
  context: Context,
): Promise<QuestionDocState | undefined> {
  const question = await reader.snapshot(QuestionDoc, questionId, context);
  return question === undefined ? undefined : { ...question };
}

export async function readQuestions(
  reader: DocumentReader,
  context: Context,
  board?: ProjectBoardState,
): Promise<QuestionDocState[]> {
  const resolved = board ?? (await readBoard(reader, context));
  const order = resolved?.questionOrder;
  if (order === undefined || order.length === 0) return [];
  const questions = await Promise.all(
    order.map((questionId) => readQuestion(reader, questionId, context)),
  );
  return questions.filter((question): question is QuestionDocState => question !== undefined);
}

export async function findWorkerByConversation(
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<WorkerDocState | undefined> {
  const workers = await readWorkers(reader, context);
  return workers.find((worker) => worker.conversationId === conversationId);
}
