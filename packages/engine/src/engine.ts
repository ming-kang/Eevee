import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationWatch, ConversationWindow } from "@earendil-works/pi-durable";
import type { McpHub, McpOAuthCredentialStore } from "@eevee/agent";
import type { ModelRuntime } from "@eevee/agent/models";
import type {
  BoardView,
  ListWorkerTasksOptions as CoreListWorkerTasksOptions,
  OutputReadOptions,
  ProjectHandle,
} from "@eevee/core";
import type * as P from "@eevee/protocol";
import type { DataDirLayout } from "./data-dir.ts";
import * as cfg from "./engine-config.ts";
import {
  disposeEngineContext,
  type EngineContext,
  type EngineLifecycleState,
  type EngineOptions,
  openEngineContext,
} from "./engine-context.ts";
import { EngineError } from "./engine-error.ts";
import * as mcp from "./engine-mcp.ts";
import * as proj from "./engine-projects.ts";
import * as prov from "./engine-providers.ts";
import * as pm from "./engine-providers-manage.ts";
import * as sk from "./engine-skills.ts";
import type { WorkerTaskStream } from "./engine-task-stream.ts";
import type { LoginSseFrame } from "./login-sessions.ts";
import type { EngineStore } from "./store.ts";

export { formatModelProfiles } from "./engine-config.ts";
export type { EngineOptions } from "./engine-context.ts";
export { EngineError } from "./engine-error.ts";
export type { ListEntriesParams } from "./engine-projects.ts";
export {
  taskStatusPhase,
  type WorkerTaskStream,
  type WorkerTaskStreamCallbacks,
} from "./engine-task-stream.ts";
export type { LoginSseFrame } from "./login-sessions.ts";
export type { OpenProjectStorage } from "./project-pool.ts";

export class Engine {
  readonly layout: DataDirLayout;
  readonly store: EngineStore;
  readonly modelRuntime: ModelRuntime;
  readonly mcpHub: McpHub;
  readonly oauthStore: McpOAuthCredentialStore;

  readonly #ctx: EngineContext;
  readonly #state: EngineLifecycleState;
  #closePromise: Promise<void> | undefined;

  private constructor(ctx: EngineContext, state: EngineLifecycleState) {
    this.#ctx = ctx;
    this.#state = state;
    this.layout = ctx.layout;
    this.store = ctx.store;
    this.modelRuntime = ctx.modelRuntime;
    this.mcpHub = ctx.mcpHub;
    this.oauthStore = ctx.oauthStore;
  }

  static async open(options: EngineOptions = {}): Promise<Engine> {
    const state: EngineLifecycleState = { closed: false };
    const ctx = await openEngineContext(options, state);
    return new Engine(ctx, state);
  }

  models(): Models {
    return this.#ctx.models();
  }

  reloadModels(): Promise<P.ReloadModelsResponse> {
    return this.#call((c) => pm.reloadModels(c.providers));
  }

  getProviderCatalog(): Promise<P.ProviderCatalogResponse> {
    return this.#call((c) => pm.getProviderCatalog(c.providers));
  }

  getProviderDetail(providerId: string): Promise<P.ProviderDetailResponse> {
    return this.#call((c) => pm.getProviderDetail(c.providers, providerId));
  }

  createProvider(input: P.UpsertProviderRequest): Promise<P.ProviderDetailResponse> {
    return this.#call((c) => pm.createProvider(c.providers, input));
  }

  updateProvider(id: string, input: P.UpsertProviderRequest): Promise<P.ProviderDetailResponse> {
    return this.#call((c) => pm.updateProvider(c.providers, id, input));
  }

  deleteProvider(providerId: string): Promise<P.OkResponse> {
    return this.#call((c) => pm.deleteProvider(c.providers, providerId));
  }

  createProviderModel(
    providerId: string,
    input: P.UpsertProviderModelRequest,
  ): Promise<P.ProviderDetailResponse> {
    return this.#call((c) => pm.createProviderModel(c.providers, providerId, input));
  }

  updateProviderModel(
    providerId: string,
    modelId: string,
    input: P.UpsertProviderModelRequest,
  ): Promise<P.ProviderDetailResponse> {
    return this.#call((c) => pm.updateProviderModel(c.providers, providerId, modelId, input));
  }

  deleteProviderModel(providerId: string, modelId: string): Promise<P.ProviderDetailResponse> {
    return this.#call((c) => pm.deleteProviderModel(c.providers, providerId, modelId));
  }

  probeDraftProvider(
    input: P.ProbeProviderRequest,
    signal?: AbortSignal,
  ): Promise<P.ProbeProviderResponse> {
    return this.#call((c) => pm.probeDraftProvider(c.providers, input, signal));
  }

  probeProvider(
    providerId: string,
    input: P.ProbeProviderRequest = {},
    signal?: AbortSignal,
  ): Promise<P.ProbeProviderResponse> {
    return this.#call((c) => pm.probeProvider(c.providers, providerId, input, signal));
  }

  importProviderModels(
    providerId: string,
    input: P.ImportProviderModelsRequest,
  ): Promise<P.ImportProviderModelsResponse> {
    return this.#call((c) => pm.importProviderModels(c.providers, providerId, input));
  }

  matchBuiltinModel(
    providerId: string,
    modelId: string,
    input: P.BuiltinModelMatchRequest = {},
  ): Promise<P.BuiltinModelMatchResponse> {
    return this.#call((c) => pm.matchBuiltinModel(c.providers, providerId, modelId, input));
  }

  testProviderModel(
    providerId: string,
    modelId: string,
    input: P.SmokeTestModelRequest = {},
    signal?: AbortSignal,
  ): Promise<P.SmokeTestModelResponse> {
    return this.#call((c) => pm.testProviderModel(c.providers, providerId, modelId, input, signal));
  }

  listProviders(): Promise<P.ListProvidersResponse> {
    return this.#call((c) => prov.listProviders(c.providers));
  }

  setProviderApiKey(providerId: string, input: P.SetApiKeyRequest): Promise<P.OkResponse> {
    return this.#call((c) => prov.setProviderApiKey(c.providers, providerId, input));
  }

  logoutProvider(providerId: string): Promise<P.OkResponse> {
    return this.#call((c) => prov.logoutProvider(c.providers, providerId));
  }

  startProviderLogin(providerId: string, input: P.StartLoginRequest): P.StartLoginResponse {
    return this.#sync((c) => c.loginSessions.start(c.models(), providerId, input.type));
  }

  subscribeLoginSession(
    providerId: string,
    sessionId: string,
    onFrame: (frame: LoginSseFrame) => void,
  ): () => void {
    return this.#sync((c) => c.loginSessions.subscribe(providerId, sessionId, onFrame));
  }

  submitLoginInput(
    providerId: string,
    sessionId: string,
    input: P.LoginInputRequest,
  ): P.OkResponse {
    return this.#sync((c) => c.loginSessions.submitInput(providerId, sessionId, input));
  }

  cancelLoginSession(providerId: string, sessionId: string): P.OkResponse {
    return this.#sync((c) => c.loginSessions.cancel(providerId, sessionId));
  }

  listModels(opts?: {
    readonly provider?: string;
    readonly available?: boolean;
  }): Promise<P.ListModelsResponse> {
    return this.#call((c) => prov.listModels(c.providers, opts));
  }

  refreshModels(input: P.RefreshModelsRequest = {}): Promise<P.RefreshModelsResponse> {
    return this.#call((c) => prov.refreshModels(c.providers, input));
  }

  getModelProfiles(): P.ModelProfilesDocument {
    return this.#sync((c) => cfg.readModelProfiles(c.store));
  }

  putModelProfiles(doc: P.ModelProfilesDocument): P.ModelProfilesDocument {
    return this.#sync((c) => cfg.putModelProfiles(c.store, doc));
  }

  listSkills(): Promise<P.SkillsListResponse> {
    return this.#call((c) => sk.listSkills(c.skills));
  }

  putSkillsPolicy(input: P.PutSkillsPolicyRequest): Promise<P.SkillsListResponse> {
    return this.#call((c) => sk.putGlobalSkillsPolicy(c.skills, input));
  }

  listProjectSkills(projectId: string): Promise<P.SkillsListResponse> {
    return this.#call((c) => sk.listSkills(c.skills, projectId));
  }

  putProjectSkillsPolicy(
    projectId: string,
    input: P.PutSkillsPolicyRequest,
  ): Promise<P.SkillsListResponse> {
    return this.#call((c) => sk.putProjectSkillsPolicy(c.skills, projectId, input));
  }

  getMcpState(): P.McpStateResponse {
    return this.#sync((c) => mcp.getMcpState(c.mcp));
  }

  putMcpConfig(input: P.PutGlobalMcpConfigRequest): Promise<P.McpStateResponse> {
    return this.#call((c) => mcp.putMcpConfig(c.mcp, input));
  }

  upsertMcpServer(
    name: string,
    input: P.UpsertGlobalMcpServerRequest,
  ): Promise<P.McpStateResponse> {
    return this.#call((c) => mcp.upsertMcpServer(c.mcp, name, input));
  }

  deleteMcpServer(name: string): Promise<P.McpStateResponse> {
    return this.#call((c) => mcp.deleteMcpServer(c.mcp, name));
  }

  reconnectMcp(input: P.ReconnectMcpRequest = {}): Promise<P.ReconnectMcpResponse> {
    return this.#call((c) => mcp.reconnectMcp(c.mcp, input));
  }

  getMcpLogs(serverName: string): P.McpLogsResponse {
    return this.#sync((c) => mcp.getMcpLogs(c.mcp, serverName));
  }

  startMcpOAuth(serverName: string): Promise<P.StartMcpOAuthResponse> {
    return this.#call((c) => c.globalOAuth.start(serverName));
  }

  subscribeMcpOAuthSession(
    serverName: string,
    sessionId: string,
    onEvent: (event: P.McpOAuthEvent) => void,
  ): () => void {
    return this.#sync((c) => c.globalOAuth.subscribe(serverName, sessionId, onEvent));
  }

  submitMcpOAuthInput(
    serverName: string,
    sessionId: string,
    input: P.McpOAuthInputRequest,
  ): P.OkResponse {
    return this.#sync((c) => c.globalOAuth.submitInput(serverName, sessionId, input));
  }

  cancelMcpOAuth(serverName: string, sessionId: string): P.OkResponse {
    return this.#sync((c) => c.globalOAuth.cancel(serverName, sessionId));
  }

  logoutMcpOAuth(serverName: string): Promise<P.OkResponse> {
    return this.#call((c) => c.globalOAuth.logout(serverName));
  }

  startProjectMcpOAuth(projectId: string, serverName: string): Promise<P.StartMcpOAuthResponse> {
    return this.#call((c) => c.projectOAuth(projectId).start(serverName));
  }

  subscribeProjectMcpOAuthSession(
    projectId: string,
    serverName: string,
    sessionId: string,
    onEvent: (event: P.McpOAuthEvent) => void,
  ): () => void {
    return this.#sync((c) => c.projectOAuth(projectId).subscribe(serverName, sessionId, onEvent));
  }

  submitProjectMcpOAuthInput(
    projectId: string,
    serverName: string,
    sessionId: string,
    input: P.McpOAuthInputRequest,
  ): P.OkResponse {
    return this.#sync((c) => c.projectOAuth(projectId).submitInput(serverName, sessionId, input));
  }

  cancelProjectMcpOAuth(projectId: string, serverName: string, sessionId: string): P.OkResponse {
    return this.#sync((c) => c.projectOAuth(projectId).cancel(serverName, sessionId));
  }

  logoutProjectMcpOAuth(projectId: string, serverName: string): Promise<P.OkResponse> {
    return this.#call((c) => c.projectOAuth(projectId).logout(serverName));
  }

  getProjectMcpState(projectId: string): P.ProjectMcpStateResponse {
    return this.#sync((c) => mcp.getProjectMcpState(c.mcp, projectId));
  }

  putProjectMcpConfig(
    projectId: string,
    input: P.PutMcpConfigRequest,
  ): Promise<P.ProjectMcpStateResponse> {
    return this.#call((c) => mcp.putProjectMcpConfig(c.mcp, projectId, input));
  }

  upsertProjectMcpServer(
    projectId: string,
    serverName: string,
    input: P.UpsertMcpServerRequest,
  ): Promise<P.ProjectMcpStateResponse> {
    return this.#call((c) => mcp.upsertProjectMcpServer(c.mcp, projectId, serverName, input));
  }

  deleteProjectMcpServer(
    projectId: string,
    serverName: string,
  ): Promise<P.ProjectMcpStateResponse> {
    return this.#call((c) => mcp.deleteProjectMcpServer(c.mcp, projectId, serverName));
  }

  reconnectProjectMcp(
    projectId: string,
    input: P.ReconnectMcpRequest = {},
  ): Promise<P.ReconnectMcpResponse> {
    return this.#call((c) => mcp.reconnectProjectMcp(c.mcp, projectId, input));
  }

  getProjectMcpLogs(projectId: string, serverName: string): P.McpLogsResponse {
    return this.#sync((c) => mcp.getProjectMcpLogs(c.mcp, projectId, serverName));
  }

  getSettings(): P.EngineSettings {
    return this.#sync((c) => cfg.readEngineSettings(c.store));
  }

  patchSettings(patch: P.EngineSettings): Promise<P.EngineSettings> {
    return this.#call((c) =>
      cfg.patchEngineSettings(c.store, patch, () => c.pool.applySettingsLive()),
    );
  }

  putSettings(next: P.EngineSettings): Promise<P.EngineSettings> {
    return this.#call((c) =>
      cfg.putEngineSettings(c.store, next, () => c.pool.applySettingsLive()),
    );
  }

  exportConfig(): Promise<P.ConfigBundle> {
    return this.#call((c) => cfg.exportEngineConfig({ layout: c.layout, store: c.store }));
  }

  importConfig(input: P.ConfigBundle): Promise<P.ConfigBundle> {
    return this.#call((c) => cfg.importEngineConfig(c.configImport, input));
  }

  createProject(input: P.CreateProjectRequest): P.ProjectSummary {
    return this.#sync((c) => proj.createProject(c.projects, input));
  }

  listProjects(): P.ProjectSummary[] {
    return this.#sync((c) => proj.listProjects(c.projects));
  }

  getProject(projectId: string): P.ProjectSummary {
    return this.#sync((c) => proj.getProject(c.projects, projectId));
  }

  updateProject(projectId: string, patch: P.UpdateProjectRequest): Promise<P.GetProjectResponse> {
    return this.#call((c) => proj.updateProject(c.projects, projectId, patch));
  }

  deleteProject(projectId: string): Promise<P.DeleteProjectResponse> {
    return this.#call((c) => proj.deleteProject(c.projects, projectId));
  }

  getProjectMemory(projectId: string): P.ProjectMemoryResponse {
    return this.#sync((c) => proj.getProjectMemory(c.projects, projectId));
  }

  putProjectMemory(projectId: string, input: P.PutProjectMemoryRequest): P.ProjectMemoryResponse {
    return this.#sync((c) => proj.putProjectMemory(c.projects, projectId, input));
  }

  getProjectUsage(projectId: string): Promise<P.ProjectUsageResponse> {
    return this.#call((c) => proj.getProjectUsage(c.projects, projectId));
  }

  recoverProjects(): Promise<void> {
    return this.#call((c) => c.pool.recoverProjects());
  }

  isProjectOpen(projectId: string): boolean {
    return this.#ctx.pool.isProjectOpen(projectId);
  }

  acquireStream(projectId: string): () => void {
    return this.#ctx.pool.acquireStream(projectId);
  }

  hibernateIdleProjects(now = Date.now()): Promise<string[]> {
    return this.#ctx.pool.hibernateIdleProjects(now);
  }

  openProject(projectId: string): Promise<ProjectHandle> {
    return this.#call((c) => c.pool.openProject(projectId));
  }

  sendMessage(
    projectId: string,
    ref: P.ConversationRef,
    input: P.SendMessageRequest,
  ): Promise<P.SendMessageResponse> {
    return this.#call((c) => proj.sendMessage(c.projects, projectId, ref, input));
  }

  listEntries(
    projectId: string,
    ref: P.ConversationRef,
    params: proj.ListEntriesParams = {},
  ): Promise<P.ListEntriesResponse> {
    return this.#call((c) => proj.listEntries(c.projects, projectId, ref, params));
  }

  interrupt(projectId: string, ref: P.ConversationRef): Promise<P.OkResponse> {
    return this.#call((c) => proj.interrupt(c.projects, projectId, ref));
  }

  retry(projectId: string, ref: P.ConversationRef): Promise<P.SendMessageResponse> {
    return this.#call((c) => proj.retry(c.projects, projectId, ref));
  }

  answerQuestion(
    projectId: string,
    questionId: P.QuestionId,
    input: P.AnswerQuestionRequest,
  ): Promise<P.AnswerQuestionResponse> {
    return this.#call((c) => proj.answerQuestion(c.projects, projectId, questionId, input));
  }

  listWorkerTasks(
    projectId: string,
    workerId: P.WorkerId,
    options?: CoreListWorkerTasksOptions,
  ): Promise<P.ListWorkerTasksResponse> {
    return this.#call((c) => proj.listWorkerTasks(c.projects, projectId, workerId, options));
  }

  readWorkerTask(
    projectId: string,
    workerId: P.WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<P.ReadWorkerTaskResponse> {
    return this.#call((c) => proj.readWorkerTask(c.projects, projectId, workerId, taskId, options));
  }

  subscribeWorkerTaskStream(
    projectId: string,
    workerId: P.WorkerId,
    taskId: string,
    options?: OutputReadOptions,
  ): Promise<WorkerTaskStream> {
    return this.#call((c) =>
      proj.subscribeTaskStream(c.projects, projectId, workerId, taskId, options),
    );
  }

  killWorkerTask(
    projectId: string,
    workerId: P.WorkerId,
    taskId: string,
  ): Promise<P.KillWorkerTaskResponse> {
    return this.#call((c) => proj.killWorkerTask(c.projects, projectId, workerId, taskId));
  }

  getBoard(projectId: string): Promise<BoardView> {
    return this.#call((c) => proj.getBoard(c.projects, projectId));
  }

  watchConversation(
    projectId: string,
    ref: P.ConversationRef,
    context: Context = BACKGROUND_CONTEXT,
    window?: ConversationWindow,
  ): Promise<ConversationWatch> {
    return this.#call((c) => proj.watchConversation(c.projects, projectId, ref, context, window));
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#dispose();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#state.closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
  }

  async #call<T>(fn: (ctx: EngineContext) => Promise<T>): Promise<T> {
    this.#assertOpen();
    return fn(this.#ctx);
  }

  #sync<T>(fn: (ctx: EngineContext) => T): T {
    this.#assertOpen();
    return fn(this.#ctx);
  }

  async #dispose(): Promise<void> {
    this.#state.closed = true;
    await disposeEngineContext(this.#ctx);
  }
}
