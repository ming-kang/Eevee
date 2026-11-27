import {
  type McpStateResponse,
  McpStateResponseSchema,
  type ProjectMcpStateResponse,
  ProjectMcpStateResponseSchema,
} from "../schemas/mcp.ts";
import { type ConversationsClient, createConversationsClient } from "./conversations.ts";
import { createScopedMcpClient, type ScopedMcpClient } from "./mcp.ts";
import { createProjectsClient, type ProjectsClient } from "./projects.ts";
import { createProvidersClient, type ProvidersClient } from "./providers.ts";
import { createSettingsClient, type SettingsClient } from "./settings.ts";
import { createScopedSkillsClient, type ScopedSkillsClient } from "./skills.ts";
import { type EeveeClientOptions, HttpTransport } from "./transport.ts";

export {
  type ConversationStreamEvent,
  type ConversationsClient,
  createConversationsClient,
  type ListEntriesOptions,
  type StreamConversationOptions,
} from "./conversations.ts";
export {
  createScopedMcpClient,
  type ScopedMcpClient,
  type StreamMcpOAuthOptions,
} from "./mcp.ts";
export {
  type AllBoardsStreamEvent,
  type BoardStreamEvent,
  createProjectsClient,
  type ListProjectFilesOptions,
  type ListWorkerTasksOptions,
  type ProjectsClient,
  type ReadWorkerTaskOptions,
  type StreamBoardOptions,
  type StreamWorkerTaskOptions,
  type TaskStreamEvent,
} from "./projects.ts";
export {
  createProvidersClient,
  type ListModelsOptions,
  type LoginStreamEvent,
  type ProvidersClient,
  type StreamLoginOptions,
} from "./providers.ts";
export { createSettingsClient, type SettingsClient } from "./settings.ts";
export { createScopedSkillsClient, type ScopedSkillsClient } from "./skills.ts";
export {
  EeveeApiError,
  type EeveeClientOptions,
  type FetchCredentials,
  type SseRequestOptions,
} from "./transport.ts";

export type GlobalSkillsFlatMethods = {
  readonly listSkills: ScopedSkillsClient["list"];
  readonly putSkillsPolicy: ScopedSkillsClient["putPolicy"];
};

export type GlobalMcpFlatMethods = {
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
};

export type ScopedMcpAccessor = {
  (): ScopedMcpClient<McpStateResponse>;
  (projectId: string): ScopedMcpClient<ProjectMcpStateResponse>;
  (projectId?: string): ScopedMcpClient<McpStateResponse | ProjectMcpStateResponse>;
};

export type EeveeClient = SettingsClient &
  ProjectsClient &
  ConversationsClient &
  ProvidersClient &
  GlobalSkillsFlatMethods &
  GlobalMcpFlatMethods & {
    readonly settings: SettingsClient;
    readonly projects: ProjectsClient;
    readonly conversations: ConversationsClient;
    readonly providers: ProvidersClient;
    readonly mcp: ScopedMcpAccessor;
    readonly skills: (projectId?: string) => ScopedSkillsClient;
  };

export type EeveeClientConstructor = new (options: EeveeClientOptions) => EeveeClient;

class EeveeClientImpl {
  readonly settings: SettingsClient;
  readonly projects: ProjectsClient;
  readonly conversations: ConversationsClient;
  readonly providers: ProvidersClient;
  readonly mcp: ScopedMcpAccessor;
  readonly skills: (projectId?: string) => ScopedSkillsClient;

  constructor(options: EeveeClientOptions) {
    const transport = new HttpTransport(options);
    const settings = createSettingsClient(transport);
    const projects = createProjectsClient(transport);
    const conversations = createConversationsClient(transport);
    const providers = createProvidersClient(transport);
    const globalMcp = createScopedMcpClient<McpStateResponse>(transport, McpStateResponseSchema);
    const globalSkills = createScopedSkillsClient(transport);

    this.settings = settings;
    this.projects = projects;
    this.conversations = conversations;
    this.providers = providers;

    function mcp(): ScopedMcpClient<McpStateResponse>;
    function mcp(projectId: string): ScopedMcpClient<ProjectMcpStateResponse>;
    function mcp(projectId?: string): ScopedMcpClient<McpStateResponse | ProjectMcpStateResponse>;
    function mcp(projectId?: string): ScopedMcpClient<McpStateResponse | ProjectMcpStateResponse> {
      return projectId === undefined
        ? globalMcp
        : createScopedMcpClient<ProjectMcpStateResponse>(
            transport,
            ProjectMcpStateResponseSchema,
            projectId,
          );
    }

    this.mcp = mcp;
    this.skills = (projectId?: string) =>
      projectId === undefined ? globalSkills : createScopedSkillsClient(transport, projectId);

    const flatSkills: GlobalSkillsFlatMethods = {
      listSkills: globalSkills.list,
      putSkillsPolicy: globalSkills.putPolicy,
    };
    const flatMcp: GlobalMcpFlatMethods = {
      getMcpState: globalMcp.getState,
      putMcpConfig: globalMcp.putConfig,
      upsertMcpServer: globalMcp.upsertServer,
      deleteMcpServer: globalMcp.deleteServer,
      reconnectMcp: globalMcp.reconnect,
      getMcpLogs: globalMcp.getLogs,
      startMcpOAuth: globalMcp.startOAuth,
      streamMcpOAuth: globalMcp.streamOAuth,
      submitMcpOAuthInput: globalMcp.submitOAuthInput,
      cancelMcpOAuth: globalMcp.cancelOAuth,
      logoutMcpOAuth: globalMcp.logoutOAuth,
    };

    const merged = Object.assign(this, settings, projects, conversations);
    Object.assign(merged, providers, flatSkills, flatMcp);
  }
}

export const EeveeClient: EeveeClientConstructor = EeveeClientImpl as EeveeClientConstructor;
