import type { OkResponse } from "../schemas/common.ts";
import {
  type McpLogsResponse,
  type McpOAuthEvent,
  type McpOAuthInputRequest,
  type McpStateResponse,
  McpStateResponseSchema,
  type ProjectMcpStateResponse,
  ProjectMcpStateResponseSchema,
  type PutMcpConfigRequest,
  type ReconnectMcpRequest,
  type ReconnectMcpResponse,
  type StartMcpOAuthResponse,
  type UpsertMcpServerRequest,
} from "../schemas/mcp.ts";
import type { PutSkillsPolicyRequest, SkillsListResponse } from "../schemas/skills.ts";
import { ConversationsClient } from "./conversations.ts";
import { ScopedMcpClient, type StreamMcpOAuthOptions } from "./mcp.ts";
import { ProjectsClient } from "./projects.ts";
import { ProvidersClient } from "./providers.ts";
import { SettingsClient } from "./settings.ts";
import { ScopedSkillsClient } from "./skills.ts";
import { type EeveeClientOptions, HttpTransport } from "./transport.ts";

export {
  type ConversationStreamEvent,
  ConversationsClient,
  type ListEntriesOptions,
  type StreamConversationOptions,
} from "./conversations.ts";
export { ScopedMcpClient, type StreamMcpOAuthOptions } from "./mcp.ts";
export {
  type BoardStreamEvent,
  type ListWorkerTasksOptions,
  ProjectsClient,
  type ReadWorkerTaskOptions,
  type StreamBoardOptions,
  type StreamWorkerTaskOptions,
  type TaskStreamEvent,
} from "./projects.ts";
export {
  type ListModelsOptions,
  type LoginStreamEvent,
  ProvidersClient,
  type StreamLoginOptions,
} from "./providers.ts";
export { SettingsClient } from "./settings.ts";
export { ScopedSkillsClient } from "./skills.ts";
export { EeveeApiError, type EeveeClientOptions, type FetchCredentials } from "./transport.ts";

export class EeveeClient {
  readonly #transport: HttpTransport;
  readonly #globalMcp: ScopedMcpClient<McpStateResponse>;
  readonly #globalSkills: ScopedSkillsClient;

  readonly getWebSession: SettingsClient["getWebSession"];
  readonly createWebSession: SettingsClient["createWebSession"];
  readonly logoutWebSession: SettingsClient["logoutWebSession"];
  readonly createWebTicket: SettingsClient["createWebTicket"];
  readonly health: SettingsClient["health"];
  readonly shutdown: SettingsClient["shutdown"];
  readonly getSettings: SettingsClient["getSettings"];
  readonly patchSettings: SettingsClient["patchSettings"];
  readonly putSettings: SettingsClient["putSettings"];
  readonly exportConfig: SettingsClient["exportConfig"];
  readonly importConfig: SettingsClient["importConfig"];

  readonly createProject: ProjectsClient["createProject"];
  readonly listProjects: ProjectsClient["listProjects"];
  readonly getProject: ProjectsClient["getProject"];
  readonly updateProject: ProjectsClient["updateProject"];
  readonly deleteProject: ProjectsClient["deleteProject"];
  readonly getProjectMemory: ProjectsClient["getProjectMemory"];
  readonly putProjectMemory: ProjectsClient["putProjectMemory"];
  readonly getProjectUsage: ProjectsClient["getProjectUsage"];
  readonly answerQuestion: ProjectsClient["answerQuestion"];
  readonly listWorkerTasks: ProjectsClient["listWorkerTasks"];
  readonly readWorkerTask: ProjectsClient["readWorkerTask"];
  readonly streamWorkerTask: ProjectsClient["streamWorkerTask"];
  readonly killWorkerTask: ProjectsClient["killWorkerTask"];
  readonly getBoard: ProjectsClient["getBoard"];
  readonly streamBoard: ProjectsClient["streamBoard"];

  readonly sendMessage: ConversationsClient["sendMessage"];
  readonly listEntries: ConversationsClient["listEntries"];
  readonly interrupt: ConversationsClient["interrupt"];
  readonly retry: ConversationsClient["retry"];
  readonly streamConversation: ConversationsClient["streamConversation"];

  readonly listProviders: ProvidersClient["listProviders"];
  readonly getProviderCatalog: ProvidersClient["getProviderCatalog"];
  readonly getProviderDetail: ProvidersClient["getProviderDetail"];
  readonly createProvider: ProvidersClient["createProvider"];
  readonly updateProvider: ProvidersClient["updateProvider"];
  readonly deleteProvider: ProvidersClient["deleteProvider"];
  readonly createProviderModel: ProvidersClient["createProviderModel"];
  readonly updateProviderModel: ProvidersClient["updateProviderModel"];
  readonly deleteProviderModel: ProvidersClient["deleteProviderModel"];
  readonly probeDraftProvider: ProvidersClient["probeDraftProvider"];
  readonly probeProvider: ProvidersClient["probeProvider"];
  readonly importProviderModels: ProvidersClient["importProviderModels"];
  readonly matchBuiltinModel: ProvidersClient["matchBuiltinModel"];
  readonly testProviderModel: ProvidersClient["testProviderModel"];
  readonly setProviderApiKey: ProvidersClient["setProviderApiKey"];
  readonly logoutProvider: ProvidersClient["logoutProvider"];
  readonly startProviderLogin: ProvidersClient["startProviderLogin"];
  readonly streamLoginSession: ProvidersClient["streamLoginSession"];
  readonly submitLoginInput: ProvidersClient["submitLoginInput"];
  readonly cancelLoginSession: ProvidersClient["cancelLoginSession"];
  readonly listModels: ProvidersClient["listModels"];
  readonly refreshModels: ProvidersClient["refreshModels"];
  readonly reloadModels: ProvidersClient["reloadModels"];
  readonly getModelProfiles: ProvidersClient["getModelProfiles"];
  readonly putModelProfiles: ProvidersClient["putModelProfiles"];

  readonly listSkills: ScopedSkillsClient["list"];
  readonly putSkillsPolicy: ScopedSkillsClient["putPolicy"];
  readonly getMcpState: ScopedMcpClient<McpStateResponse>["getState"];
  readonly putMcpConfig: ScopedMcpClient<McpStateResponse>["putConfig"];
  readonly upsertMcpServer: ScopedMcpClient<McpStateResponse>["upsertServer"];
  readonly deleteMcpServer: ScopedMcpClient<McpStateResponse>["deleteServer"];
  readonly reconnectMcp: ScopedMcpClient<McpStateResponse>["reconnect"];
  readonly getMcpLogs: ScopedMcpClient<McpStateResponse>["getLogs"];
  readonly startMcpOAuth: ScopedMcpClient<McpStateResponse>["startOAuth"];
  readonly streamMcpOAuth: ScopedMcpClient<McpStateResponse>["streamOAuth"];
  readonly submitMcpOAuthInput: ScopedMcpClient<McpStateResponse>["submitOAuthInput"];
  readonly cancelMcpOAuth: ScopedMcpClient<McpStateResponse>["cancelOAuth"];
  readonly logoutMcpOAuth: ScopedMcpClient<McpStateResponse>["logoutOAuth"];

  constructor(options: EeveeClientOptions) {
    this.#transport = new HttpTransport(options);
    const settings = new SettingsClient(this.#transport);
    const projects = new ProjectsClient(this.#transport);
    const conversations = new ConversationsClient(this.#transport);
    const providers = new ProvidersClient(this.#transport);
    this.#globalMcp = new ScopedMcpClient<McpStateResponse>(
      this.#transport,
      McpStateResponseSchema,
    );
    this.#globalSkills = new ScopedSkillsClient(this.#transport);

    this.getWebSession = settings.getWebSession.bind(settings);
    this.createWebSession = settings.createWebSession.bind(settings);
    this.logoutWebSession = settings.logoutWebSession.bind(settings);
    this.createWebTicket = settings.createWebTicket.bind(settings);
    this.health = settings.health.bind(settings);
    this.shutdown = settings.shutdown.bind(settings);
    this.getSettings = settings.getSettings.bind(settings);
    this.patchSettings = settings.patchSettings.bind(settings);
    this.putSettings = settings.putSettings.bind(settings);
    this.exportConfig = settings.exportConfig.bind(settings);
    this.importConfig = settings.importConfig.bind(settings);

    this.createProject = projects.createProject.bind(projects);
    this.listProjects = projects.listProjects.bind(projects);
    this.getProject = projects.getProject.bind(projects);
    this.updateProject = projects.updateProject.bind(projects);
    this.deleteProject = projects.deleteProject.bind(projects);
    this.getProjectMemory = projects.getProjectMemory.bind(projects);
    this.putProjectMemory = projects.putProjectMemory.bind(projects);
    this.getProjectUsage = projects.getProjectUsage.bind(projects);
    this.answerQuestion = projects.answerQuestion.bind(projects);
    this.listWorkerTasks = projects.listWorkerTasks.bind(projects);
    this.readWorkerTask = projects.readWorkerTask.bind(projects);
    this.streamWorkerTask = projects.streamWorkerTask.bind(projects);
    this.killWorkerTask = projects.killWorkerTask.bind(projects);
    this.getBoard = projects.getBoard.bind(projects);
    this.streamBoard = projects.streamBoard.bind(projects);

    this.sendMessage = conversations.sendMessage.bind(conversations);
    this.listEntries = conversations.listEntries.bind(conversations);
    this.interrupt = conversations.interrupt.bind(conversations);
    this.retry = conversations.retry.bind(conversations);
    this.streamConversation = conversations.streamConversation.bind(conversations);

    this.listProviders = providers.listProviders.bind(providers);
    this.getProviderCatalog = providers.getProviderCatalog.bind(providers);
    this.getProviderDetail = providers.getProviderDetail.bind(providers);
    this.createProvider = providers.createProvider.bind(providers);
    this.updateProvider = providers.updateProvider.bind(providers);
    this.deleteProvider = providers.deleteProvider.bind(providers);
    this.createProviderModel = providers.createProviderModel.bind(providers);
    this.updateProviderModel = providers.updateProviderModel.bind(providers);
    this.deleteProviderModel = providers.deleteProviderModel.bind(providers);
    this.probeDraftProvider = providers.probeDraftProvider.bind(providers);
    this.probeProvider = providers.probeProvider.bind(providers);
    this.importProviderModels = providers.importProviderModels.bind(providers);
    this.matchBuiltinModel = providers.matchBuiltinModel.bind(providers);
    this.testProviderModel = providers.testProviderModel.bind(providers);
    this.setProviderApiKey = providers.setProviderApiKey.bind(providers);
    this.logoutProvider = providers.logoutProvider.bind(providers);
    this.startProviderLogin = providers.startProviderLogin.bind(providers);
    this.streamLoginSession = providers.streamLoginSession.bind(providers);
    this.submitLoginInput = providers.submitLoginInput.bind(providers);
    this.cancelLoginSession = providers.cancelLoginSession.bind(providers);
    this.listModels = providers.listModels.bind(providers);
    this.refreshModels = providers.refreshModels.bind(providers);
    this.reloadModels = providers.reloadModels.bind(providers);
    this.getModelProfiles = providers.getModelProfiles.bind(providers);
    this.putModelProfiles = providers.putModelProfiles.bind(providers);

    this.listSkills = this.#globalSkills.list.bind(this.#globalSkills);
    this.putSkillsPolicy = this.#globalSkills.putPolicy.bind(this.#globalSkills);
    this.getMcpState = this.#globalMcp.getState.bind(this.#globalMcp);
    this.putMcpConfig = this.#globalMcp.putConfig.bind(this.#globalMcp);
    this.upsertMcpServer = this.#globalMcp.upsertServer.bind(this.#globalMcp);
    this.deleteMcpServer = this.#globalMcp.deleteServer.bind(this.#globalMcp);
    this.reconnectMcp = this.#globalMcp.reconnect.bind(this.#globalMcp);
    this.getMcpLogs = this.#globalMcp.getLogs.bind(this.#globalMcp);
    this.startMcpOAuth = this.#globalMcp.startOAuth.bind(this.#globalMcp);
    this.streamMcpOAuth = this.#globalMcp.streamOAuth.bind(this.#globalMcp);
    this.submitMcpOAuthInput = this.#globalMcp.submitOAuthInput.bind(this.#globalMcp);
    this.cancelMcpOAuth = this.#globalMcp.cancelOAuth.bind(this.#globalMcp);
    this.logoutMcpOAuth = this.#globalMcp.logoutOAuth.bind(this.#globalMcp);
  }

  mcp(): ScopedMcpClient<McpStateResponse>;
  mcp(projectId: string): ScopedMcpClient<ProjectMcpStateResponse>;
  mcp(projectId?: string): ScopedMcpClient<McpStateResponse | ProjectMcpStateResponse>;
  mcp(projectId?: string): ScopedMcpClient<McpStateResponse | ProjectMcpStateResponse> {
    if (projectId === undefined) return this.#globalMcp;
    return new ScopedMcpClient<ProjectMcpStateResponse>(
      this.#transport,
      ProjectMcpStateResponseSchema,
      projectId,
    );
  }

  skills(projectId?: string): ScopedSkillsClient {
    return projectId === undefined
      ? this.#globalSkills
      : new ScopedSkillsClient(this.#transport, projectId);
  }

  listProjectSkills(projectId: string, signal?: AbortSignal): Promise<SkillsListResponse> {
    return this.skills(projectId).list(signal);
  }

  putProjectSkillsPolicy(
    projectId: string,
    input: PutSkillsPolicyRequest,
    signal?: AbortSignal,
  ): Promise<SkillsListResponse> {
    return this.skills(projectId).putPolicy(input, signal);
  }

  getProjectMcpState(projectId: string, signal?: AbortSignal): Promise<ProjectMcpStateResponse> {
    return this.mcp(projectId).getState(signal);
  }

  putProjectMcpConfig(
    projectId: string,
    input: PutMcpConfigRequest,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    return this.mcp(projectId).putConfig(input, signal);
  }

  upsertProjectMcpServer(
    projectId: string,
    serverName: string,
    input: UpsertMcpServerRequest,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    return this.mcp(projectId).upsertServer(serverName, input, signal);
  }

  deleteProjectMcpServer(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<ProjectMcpStateResponse> {
    return this.mcp(projectId).deleteServer(serverName, signal);
  }

  reconnectProjectMcp(
    projectId: string,
    input: ReconnectMcpRequest = {},
    signal?: AbortSignal,
  ): Promise<ReconnectMcpResponse> {
    return this.mcp(projectId).reconnect(input, signal);
  }

  getProjectMcpLogs(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<McpLogsResponse> {
    return this.mcp(projectId).getLogs(serverName, signal);
  }

  startProjectMcpOAuth(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<StartMcpOAuthResponse> {
    return this.mcp(projectId).startOAuth(serverName, signal);
  }

  streamProjectMcpOAuth(
    projectId: string,
    serverName: string,
    sessionId: string,
    opts?: StreamMcpOAuthOptions,
  ): AsyncGenerator<McpOAuthEvent> {
    return this.mcp(projectId).streamOAuth(serverName, sessionId, opts);
  }

  submitProjectMcpOAuthInput(
    projectId: string,
    serverName: string,
    sessionId: string,
    input: McpOAuthInputRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    return this.mcp(projectId).submitOAuthInput(serverName, sessionId, input, signal);
  }

  cancelProjectMcpOAuth(
    projectId: string,
    serverName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    return this.mcp(projectId).cancelOAuth(serverName, sessionId, signal);
  }

  logoutProjectMcpOAuth(
    projectId: string,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    return this.mcp(projectId).logoutOAuth(serverName, signal);
  }
}
