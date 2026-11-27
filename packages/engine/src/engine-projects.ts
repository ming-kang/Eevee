import { rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type {
  ConversationWatch,
  ConversationWindow,
  EntryId,
  EntryQuery,
  Submission,
} from "@earendil-works/pi-durable";
import type {
  BoardView,
  ListWorkerTasksOptions as CoreListWorkerTasksOptions,
  QuestionId as CoreQuestionId,
  WorkerId as CoreWorkerId,
  OutputReadOptions,
  ProjectHandle,
  ProjectTarget,
} from "@eevee/core";
import type {
  AnswerQuestionRequest,
  AnswerQuestionResponse,
  ConversationRef,
  CreateProjectRequest,
  DeleteProjectResponse,
  EntryRecordPayload,
  GetProjectResponse,
  KillWorkerTaskResponse,
  ListEntriesResponse,
  ListWorkerTasksResponse,
  OkResponse,
  ProjectMemoryResponse,
  ProjectSummary,
  ProjectUsageResponse,
  PutProjectMemoryRequest,
  QuestionId,
  ReadWorkerTaskResponse,
  ScanOrder,
  SendMessageRequest,
  SendMessageResponse,
  UpdateProjectRequest,
  WorkerId,
} from "@eevee/protocol";
import { validateTaskReadOptions as validateProtocolTaskReadOptions } from "@eevee/protocol";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { type DataDirLayout, projectPaths } from "./data-dir.ts";
import type { EngineKnobs } from "./engine-config.ts";
import { EngineError, toEngineError } from "./engine-error.ts";
import { expandMessageSkills, type SkillsDeps } from "./engine-skills.ts";
import { subscribeWorkerTaskStream, type WorkerTaskStream } from "./engine-task-stream.ts";
import type { ProjectPool } from "./project-pool.ts";
import type { EngineStore } from "./store.ts";

export type ListEntriesParams = {
  readonly order?: ScanOrder;
  readonly limit?: number;
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly cursor?: string;
};

export type ProjectOpsDeps = {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly pool: ProjectPool;
  readonly knobs: EngineKnobs;
  readonly skills: SkillsDeps;
  readonly cancelProjectOAuth: (projectId: string) => Promise<void>;
};

function conversationTarget(ref: ConversationRef): ProjectTarget {
  return ref === "router" ? "router" : (ref as CoreWorkerId);
}

async function submissionResponse(submission: Submission): Promise<SendMessageResponse> {
  const { status } = await submission.status(BACKGROUND_CONTEXT);
  return { submissionId: submission.id, status };
}

async function inProject<T>(
  deps: ProjectOpsDeps,
  projectId: string,
  run: (handle: ProjectHandle) => Promise<T>,
): Promise<T> {
  const handle = await deps.pool.openProject(projectId);
  try {
    return await run(handle);
  } catch (error) {
    throw toEngineError(error);
  } finally {
    deps.pool.touch(projectId);
  }
}

export function createProject(deps: ProjectOpsDeps, input: CreateProjectRequest): ProjectSummary {
  if (input.workspaces.length === 0) {
    throw new EngineError(400, "invalid_request", "workspaces must contain at least one directory");
  }
  try {
    return deps.store.createProject(input);
  } catch (error) {
    if (error instanceof Error) {
      throw new EngineError(400, "invalid_request", error.message);
    }
    throw error;
  }
}

export function listProjects(deps: ProjectOpsDeps): ProjectSummary[] {
  return deps.store.listProjects();
}

export function getProject(deps: ProjectOpsDeps, projectId: string): ProjectSummary {
  if (deps.pool.isDeleting(projectId)) {
    throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
  }
  const project = deps.store.getProject(projectId);
  if (project === undefined) {
    throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
  }
  return project;
}

export async function updateProject(
  deps: ProjectOpsDeps,
  projectId: string,
  patch: UpdateProjectRequest,
): Promise<GetProjectResponse> {
  getProject(deps, projectId);
  let updated: ProjectSummary | undefined;
  try {
    updated = deps.store.updateProject(projectId, patch);
  } catch (error) {
    if (error instanceof Error) {
      throw new EngineError(400, "invalid_request", error.message);
    }
    throw error;
  }
  if (updated === undefined) {
    throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
  }
  const openHandle = deps.pool.getOpenHandle(projectId);
  if (openHandle !== undefined) {
    deps.pool.touch(projectId);
    if (patch.models !== undefined) {
      await openHandle.reconfigureRouterModel(deps.knobs.modelSlots(projectId).router);
    }
    if (patch.workspaces !== undefined) {
      await openHandle.reconfigureWorkspaces(updated.workspaces);
      await deps.pool.updateProjectMcpRoots(projectId, updated.workspaces);
    }
    if (patch.tools !== undefined) {
      await openHandle.reconfigureTools();
    }
  }
  return { project: updated };
}

export async function deleteProject(
  deps: ProjectOpsDeps,
  projectId: string,
): Promise<DeleteProjectResponse> {
  getProject(deps, projectId);
  await deps.cancelProjectOAuth(projectId);
  await deps.pool.deleteOpenProject(projectId, async () => {
    deps.store.deleteProject(projectId);
    const paths = projectPaths(deps.layout, projectId);
    await rm(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { ok: true, id: projectId };
}

export function getProjectMemory(deps: ProjectOpsDeps, projectId: string): ProjectMemoryResponse {
  const project = getProject(deps, projectId);
  return { projectId: project.id, memory: project.memory ?? null };
}

export function putProjectMemory(
  deps: ProjectOpsDeps,
  projectId: string,
  input: PutProjectMemoryRequest,
): ProjectMemoryResponse {
  getProject(deps, projectId);
  const updated = deps.store.updateProject(projectId, { memory: input.memory });
  if (updated === undefined) {
    throw new EngineError(404, "project_not_found", `Unknown project ${projectId}`);
  }
  deps.pool.touch(projectId);
  return { projectId: updated.id, memory: updated.memory ?? null };
}

export async function getProjectUsage(
  deps: ProjectOpsDeps,
  projectId: string,
): Promise<ProjectUsageResponse> {
  return inProject(deps, projectId, async (handle) => ({
    projectId,
    usage: await handle.usage(BACKGROUND_CONTEXT),
  }));
}

export async function sendMessage(
  deps: ProjectOpsDeps,
  projectId: string,
  ref: ConversationRef,
  input: SendMessageRequest,
): Promise<SendMessageResponse> {
  const expandedText = await expandMessageSkills(deps.skills, projectId, input.text);
  const options = input.whenBusy === undefined ? undefined : { whenBusy: input.whenBusy };
  return inProject(deps, projectId, async (handle) =>
    submissionResponse(await handle.send(conversationTarget(ref), expandedText, options)),
  );
}

export async function listEntries(
  deps: ProjectOpsDeps,
  projectId: string,
  ref: ConversationRef,
  params: ListEntriesParams = {},
): Promise<ListEntriesResponse> {
  const limit = params.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new EngineError(400, "invalid_query", "limit must be an integer between 1 and 500");
  }
  const cursor = params.cursor === undefined ? undefined : decodeCursor(params.cursor);
  const query: Omit<EntryQuery, "conversationId"> = {
    ...(params.order === undefined ? {} : { order: params.order }),
    ...(params.minEntryId === undefined ? {} : { minEntryId: params.minEntryId as EntryId }),
    ...(params.maxEntryId === undefined ? {} : { maxEntryId: params.maxEntryId as EntryId }),
  };
  return inProject(deps, projectId, async (handle) => {
    const page = await handle.listEntries(
      conversationTarget(ref),
      query,
      limit,
      cursor,
      BACKGROUND_CONTEXT,
    );
    return {
      entries: page.items as unknown as EntryRecordPayload[],
      ...(page.next === undefined ? {} : { nextCursor: encodeCursor(page.next) }),
    };
  });
}

export async function interrupt(
  deps: ProjectOpsDeps,
  projectId: string,
  ref: ConversationRef,
): Promise<OkResponse> {
  return inProject(deps, projectId, async (handle) => {
    await handle.interrupt(conversationTarget(ref), BACKGROUND_CONTEXT);
    return { ok: true };
  });
}

export async function retry(
  deps: ProjectOpsDeps,
  projectId: string,
  ref: ConversationRef,
): Promise<SendMessageResponse> {
  return inProject(deps, projectId, async (handle) =>
    submissionResponse(await handle.retry(conversationTarget(ref), BACKGROUND_CONTEXT)),
  );
}

export async function answerQuestion(
  deps: ProjectOpsDeps,
  projectId: string,
  questionId: QuestionId,
  input: AnswerQuestionRequest,
): Promise<AnswerQuestionResponse> {
  return inProject(deps, projectId, async (handle) => ({
    question: await handle.answerQuestion(
      questionId as CoreQuestionId,
      input.answers,
      BACKGROUND_CONTEXT,
    ),
  }));
}

export async function listWorkerTasks(
  deps: ProjectOpsDeps,
  projectId: string,
  workerId: WorkerId,
  options?: CoreListWorkerTasksOptions,
): Promise<ListWorkerTasksResponse> {
  if (
    options?.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new EngineError(400, "invalid_query", "limit must be an integer between 1 and 100");
  }
  return inProject(deps, projectId, async (handle) => ({
    tasks: [
      ...(await handle.listWorkerTasks(workerId as CoreWorkerId, options, BACKGROUND_CONTEXT)),
    ],
  }));
}

function validateTaskReadOptions(options?: OutputReadOptions): void {
  if (options === undefined) return;
  try {
    validateProtocolTaskReadOptions(options);
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_query",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readWorkerTask(
  deps: ProjectOpsDeps,
  projectId: string,
  workerId: WorkerId,
  taskId: string,
  options?: OutputReadOptions,
): Promise<ReadWorkerTaskResponse> {
  validateTaskReadOptions(options);
  return inProject(deps, projectId, (handle) =>
    handle.readWorkerTaskOutput(workerId as CoreWorkerId, taskId, options, BACKGROUND_CONTEXT),
  );
}

export async function subscribeTaskStream(
  deps: ProjectOpsDeps,
  projectId: string,
  workerId: WorkerId,
  taskId: string,
  options?: OutputReadOptions,
): Promise<WorkerTaskStream> {
  validateTaskReadOptions(options);
  return inProject(deps, projectId, (handle) =>
    subscribeWorkerTaskStream(handle, workerId, taskId, options),
  );
}

export async function killWorkerTask(
  deps: ProjectOpsDeps,
  projectId: string,
  workerId: WorkerId,
  taskId: string,
): Promise<KillWorkerTaskResponse> {
  return inProject(deps, projectId, async (handle) => ({
    task: await handle.killWorkerTask(workerId as CoreWorkerId, taskId, BACKGROUND_CONTEXT),
  }));
}

export async function getBoard(deps: ProjectOpsDeps, projectId: string): Promise<BoardView> {
  return inProject(deps, projectId, (handle) => handle.board(BACKGROUND_CONTEXT));
}

export async function watchConversation(
  deps: ProjectOpsDeps,
  projectId: string,
  ref: ConversationRef,
  context: Context = BACKGROUND_CONTEXT,
  window?: ConversationWindow,
): Promise<ConversationWatch> {
  return inProject(deps, projectId, (handle) =>
    handle.watchConversation(conversationTarget(ref), context, window),
  );
}
