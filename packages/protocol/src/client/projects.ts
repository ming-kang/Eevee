import {
  type QuestionId,
  type StreamEndEvent,
  StreamEndEventSchema,
  type TaskListStatusFilter,
  type TaskReadMode,
  type WorkerId,
} from "../schemas/common.ts";
import {
  type AnswerQuestionRequest,
  type AnswerQuestionResponse,
  AnswerQuestionResponseSchema,
  type BackgroundTaskRecordPayload,
  type BoardViewPayload,
  BoardViewSchema,
  type CreateProjectRequest,
  type CreateProjectResponse,
  CreateProjectResponseSchema,
  type DeleteProjectResponse,
  DeleteProjectResponseSchema,
  type GetProjectResponse,
  GetProjectResponseSchema,
  type KillWorkerTaskResponse,
  KillWorkerTaskResponseSchema,
  type ListProjectsResponse,
  ListProjectsResponseSchema,
  type ListWorkerTasksResponse,
  ListWorkerTasksResponseSchema,
  type OutputSlice,
  type ProjectMemoryResponse,
  ProjectMemoryResponseSchema,
  type ProjectUsageResponse,
  ProjectUsageResponseSchema,
  type PutProjectMemoryRequest,
  type ReadWorkerTaskResponse,
  ReadWorkerTaskResponseSchema,
  TaskStreamChunkEventSchema,
  TaskStreamSnapshotEventSchema,
  TaskStreamStatusEventSchema,
  type UpdateProjectRequest,
} from "../schemas/project.ts";
import { buildQuery, type HttpTransport } from "./transport.ts";

export type BoardStreamEvent =
  | { readonly type: "board"; readonly board: BoardViewPayload }
  | {
      readonly type: "end";
      readonly reason: StreamEndEvent["reason"];
      readonly message?: string;
    };

export type StreamBoardOptions = { readonly signal?: AbortSignal };

export type ReadWorkerTaskOptions = {
  readonly mode?: TaskReadMode;
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly endByte?: number;
  readonly filter?: string;
  readonly contextLines?: number;
  readonly signal?: AbortSignal;
};

export type ListWorkerTasksOptions = {
  readonly status?: TaskListStatusFilter;
  readonly limit?: number;
  readonly signal?: AbortSignal;
};

export type StreamWorkerTaskOptions = {
  readonly mode?: TaskReadMode;
  readonly bytes?: number;
  readonly sinceBytes?: number;
  readonly signal?: AbortSignal;
};

export type TaskStreamEvent =
  | {
      readonly type: "snapshot";
      readonly task: BackgroundTaskRecordPayload;
      readonly output: OutputSlice;
    }
  | {
      readonly type: "chunk";
      readonly text: string;
      readonly fromByte: number;
      readonly endByte: number;
      readonly totalBytes: number;
    }
  | { readonly type: "status"; readonly task: BackgroundTaskRecordPayload }
  | {
      readonly type: "end";
      readonly reason: StreamEndEvent["reason"];
      readonly message?: string;
    };

export class ProjectsClient {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.#transport = transport;
  }

  createProject(input: CreateProjectRequest, signal?: AbortSignal): Promise<CreateProjectResponse> {
    return this.#transport.post("/projects", CreateProjectResponseSchema, input, signal);
  }

  listProjects(signal?: AbortSignal): Promise<ListProjectsResponse> {
    return this.#transport.get("/projects", ListProjectsResponseSchema, signal);
  }

  getProject(id: string, signal?: AbortSignal): Promise<GetProjectResponse> {
    return this.#transport.get(
      `/projects/${encodeURIComponent(id)}`,
      GetProjectResponseSchema,
      signal,
    );
  }

  updateProject(
    id: string,
    input: UpdateProjectRequest,
    signal?: AbortSignal,
  ): Promise<GetProjectResponse> {
    return this.#transport.patch(
      `/projects/${encodeURIComponent(id)}`,
      GetProjectResponseSchema,
      input,
      signal,
    );
  }

  deleteProject(id: string, signal?: AbortSignal): Promise<DeleteProjectResponse> {
    return this.#transport.del(
      `/projects/${encodeURIComponent(id)}`,
      DeleteProjectResponseSchema,
      signal,
    );
  }

  getProjectMemory(id: string, signal?: AbortSignal): Promise<ProjectMemoryResponse> {
    return this.#transport.get(
      `/projects/${encodeURIComponent(id)}/memory`,
      ProjectMemoryResponseSchema,
      signal,
    );
  }

  putProjectMemory(
    id: string,
    input: PutProjectMemoryRequest,
    signal?: AbortSignal,
  ): Promise<ProjectMemoryResponse> {
    return this.#transport.put(
      `/projects/${encodeURIComponent(id)}/memory`,
      ProjectMemoryResponseSchema,
      input,
      signal,
    );
  }

  getProjectUsage(id: string, signal?: AbortSignal): Promise<ProjectUsageResponse> {
    return this.#transport.get(
      `/projects/${encodeURIComponent(id)}/usage`,
      ProjectUsageResponseSchema,
      signal,
    );
  }

  answerQuestion(
    projectId: string,
    questionId: QuestionId,
    input: AnswerQuestionRequest,
    signal?: AbortSignal,
  ): Promise<AnswerQuestionResponse> {
    return this.#transport.post(
      `/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(questionId)}/answer`,
      AnswerQuestionResponseSchema,
      input,
      signal,
    );
  }

  listWorkerTasks(
    projectId: string,
    workerId: WorkerId,
    opts?: ListWorkerTasksOptions,
  ): Promise<ListWorkerTasksResponse> {
    const query = buildQuery({ status: opts?.status, limit: opts?.limit });
    return this.#transport.get(
      `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks${query}`,
      ListWorkerTasksResponseSchema,
      opts?.signal,
    );
  }

  readWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    opts?: ReadWorkerTaskOptions,
  ): Promise<ReadWorkerTaskResponse> {
    const query = buildQuery({
      mode: opts?.mode,
      bytes: opts?.bytes,
      sinceBytes: opts?.sinceBytes,
      endByte: opts?.endByte,
      filter: opts?.filter,
      contextLines: opts?.contextLines,
    });
    return this.#transport.get(
      `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}${query}`,
      ReadWorkerTaskResponseSchema,
      opts?.signal,
    );
  }

  async *streamWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    opts?: StreamWorkerTaskOptions,
  ): AsyncGenerator<TaskStreamEvent> {
    const query = buildQuery({
      mode: opts?.mode,
      bytes: opts?.bytes,
      sinceBytes: opts?.sinceBytes,
    });
    const path = `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}/stream${query}`;
    for await (const sse of this.#transport.streamSse(path, opts?.signal)) {
      if (sse.event === "snapshot") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          TaskStreamSnapshotEventSchema,
          "task snapshot SSE payload",
        );
        yield { type: "snapshot", task: parsed.task, output: parsed.output };
      } else if (sse.event === "chunk") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          TaskStreamChunkEventSchema,
          "task chunk SSE payload",
        );
        yield {
          type: "chunk",
          text: parsed.text,
          fromByte: parsed.fromByte,
          endByte: parsed.endByte,
          totalBytes: parsed.totalBytes,
        };
      } else if (sse.event === "status") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          TaskStreamStatusEventSchema,
          "task status SSE payload",
        );
        yield { type: "status", task: parsed.task };
      } else if (sse.event === "end") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          StreamEndEventSchema,
          "task end SSE payload",
        );
        yield {
          type: "end",
          reason: parsed.reason,
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
        };
        return;
      }
    }
  }

  killWorkerTask(
    projectId: string,
    workerId: WorkerId,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<KillWorkerTaskResponse> {
    return this.#transport.post(
      `/projects/${encodeURIComponent(projectId)}/workers/${encodeURIComponent(workerId)}/tasks/${encodeURIComponent(taskId)}/kill`,
      KillWorkerTaskResponseSchema,
      undefined,
      signal,
    );
  }

  getBoard(projectId: string, signal?: AbortSignal): Promise<BoardViewPayload> {
    return this.#transport.get(
      `/projects/${encodeURIComponent(projectId)}/board`,
      BoardViewSchema,
      signal,
    );
  }

  async *streamBoard(
    projectId: string,
    opts?: StreamBoardOptions,
  ): AsyncGenerator<BoardStreamEvent> {
    const path = `/projects/${encodeURIComponent(projectId)}/board/stream`;
    for await (const sse of this.#transport.streamSse(path, opts?.signal)) {
      if (sse.event === "board") {
        const board = this.#transport.decodeSseEvent(sse, BoardViewSchema, "board SSE payload");
        yield { type: "board", board };
      } else if (sse.event === "end") {
        const end = this.#transport.decodeSseEvent(
          sse,
          StreamEndEventSchema,
          "board end SSE payload",
        );
        yield {
          type: "end",
          reason: end.reason,
          ...(end.message === undefined ? {} : { message: end.message }),
        };
        return;
      }
    }
  }
}
