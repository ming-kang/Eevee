import {
  arr,
  bool,
  int,
  lit,
  map,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
  unsafe,
} from "@earendil-works/pi-schema";

export const McpServerStatusSchema = oneOf([
  "idle",
  "connecting",
  "connected",
  "auth_required",
  "degraded",
  "disconnected",
  "failed",
  "disabled",
  "closed",
]);
export type McpServerStatusPayload = Static<typeof McpServerStatusSchema>;
export type McpServerStatus = McpServerStatusPayload;

export const MCP_EXPOSURES = ["deferred", "direct", "codemode", "hidden"] as const;

export const McpExposureSchema = oneOf(MCP_EXPOSURES);
export type McpExposure = Static<typeof McpExposureSchema>;

const McpExposureInputSchema = oneOf([...MCP_EXPOSURES, "codemode-deferred"]);

export const McpServerRolesSchema = obj({
  router: bool(),
  worker: bool(),
});
export type McpServerRoles = Static<typeof McpServerRolesSchema>;

const McpServerRolesInputSchema = obj({
  router: opt(bool()),
  worker: opt(bool()),
});

export const McpServerToolSummarySchema = obj({
  name: str(),
  description: opt(str()),
  exposure: McpExposureSchema,
});
export type McpServerToolSummary = Static<typeof McpServerToolSummarySchema>;

export const McpServerSnapshotSchema = obj({
  name: str({ minLength: 1 }),
  status: McpServerStatusSchema,
  enabled: bool(),
  description: opt(str()),
  instructions: opt(str()),
  toolCount: int({ minimum: 0 }),
  error: opt(str()),
  transport: opt(oneOf(["stdio", "http"])),
  roles: opt(McpServerRolesSchema),
  exposure: opt(McpExposureSchema),
  hasResources: opt(bool()),
  authRequired: opt(bool()),
  tools: opt(arr(McpServerToolSummarySchema)),
  recentLogs: opt(arr(str())),
  scope: opt(oneOf(["global", "project", "override"])),
});
export type McpServerSnapshotPayload = Static<typeof McpServerSnapshotSchema>;
export type McpServerSnapshot = McpServerSnapshotPayload;

export const McpOAuthConfigSchema = obj({
  clientId: opt(str()),
  clientSecret: opt(str()),
  callbackPort: opt(int({ minimum: 1, maximum: 65535 })),
  callbackUrl: opt(str()),
  scope: opt(str()),
  clientName: opt(str()),
  clientRegistration: opt(oneOf(["auto", "dcr", "cimd"])),
  authServerMetadataUrl: opt(str()),
});
export type McpOAuthConfigPayload = Static<typeof McpOAuthConfigSchema>;

const MCP_CONFIG_BASE_FIELDS = {
  description: opt(str()),
  enabled: opt(bool()),
  timeout: opt(num({ exclusiveMinimum: 0 })),
  exposure: opt(McpExposureInputSchema),
  toolExposure: opt(map(McpExposureInputSchema)),
  roles: opt(McpServerRolesInputSchema),
} as const;

export const McpStdioServerConfigSchema = obj({
  ...MCP_CONFIG_BASE_FIELDS,
  type: opt(lit("stdio")),
  command: str({ minLength: 1 }),
  args: opt(arr(str())),
  env: opt(map(str())),
  cwd: opt(str()),
});
export type McpStdioServerConfigPayload = Static<typeof McpStdioServerConfigSchema>;

export const McpHttpServerConfigSchema = obj({
  ...MCP_CONFIG_BASE_FIELDS,
  type: opt(oneOf(["http", "streamable-http"])),
  url: str({ minLength: 1 }),
  headers: opt(map(str())),
  oauth: opt(McpOAuthConfigSchema),
});
export type McpHttpServerConfigPayload = Static<typeof McpHttpServerConfigSchema>;

export const McpServerConfigSchema = union([McpStdioServerConfigSchema, McpHttpServerConfigSchema]);
export type McpServerConfigPayload = Static<typeof McpServerConfigSchema>;

export const McpServerOverrideSchema = obj({
  ...MCP_CONFIG_BASE_FIELDS,
});
export type McpServerOverridePayload = Static<typeof McpServerOverrideSchema>;

export const McpServerEntryInputSchema = union([
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema,
  McpServerOverrideSchema,
]);
export type McpServerEntryInput = Static<typeof McpServerEntryInputSchema>;

// Keep wire containers assignable from existing Record<string, unknown> callers while enforcing McpServerEntryInputSchema at runtime.
export const McpServerEntryFieldSchema = unsafe<McpServerEntryInput | Record<string, unknown>>(
  McpServerEntryInputSchema,
);

export const McpStateResponseSchema = obj({
  servers: map(McpServerEntryFieldSchema),
  status: arr(McpServerSnapshotSchema),
});
export type McpStateResponse = Static<typeof McpStateResponseSchema>;

export const McpLogsResponseSchema = obj({
  server: str(),
  lines: arr(str()),
  logPath: opt(str()),
});
export type McpLogsResponse = Static<typeof McpLogsResponseSchema>;

export const StartMcpOAuthResponseSchema = obj({
  sessionId: str({ minLength: 1 }),
  server: str({ minLength: 1 }),
});
export type StartMcpOAuthResponse = Static<typeof StartMcpOAuthResponseSchema>;

export const McpOAuthInputRequestSchema = obj({ redirectUrl: str({ minLength: 1 }) });
export type McpOAuthInputRequest = Static<typeof McpOAuthInputRequestSchema>;

export const McpOAuthEventSchema = union([
  obj({
    type: lit("auth_url"),
    url: str(),
    redirectUrl: str(),
    instructions: opt(str()),
  }),
  obj({ type: lit("progress"), message: str() }),
  obj({ type: lit("complete") }),
  obj({ type: lit("error"), code: str(), message: str() }),
]);
export type McpOAuthEvent = Static<typeof McpOAuthEventSchema>;

export const ProjectMcpStateResponseSchema = obj({
  globalServers: map(McpServerEntryFieldSchema),
  projectServers: map(McpServerEntryFieldSchema),
  effectiveServers: map(McpServerEntryFieldSchema),
  status: arr(McpServerSnapshotSchema),
});
export type ProjectMcpStateResponse = Static<typeof ProjectMcpStateResponseSchema>;

export const PutMcpConfigRequestSchema = obj({
  servers: map(McpServerEntryFieldSchema),
});
export type PutMcpConfigRequest = Static<typeof PutMcpConfigRequestSchema>;

export const UpsertMcpServerRequestSchema = obj({
  config: McpServerEntryFieldSchema,
});
export type UpsertMcpServerRequest = Static<typeof UpsertMcpServerRequestSchema>;

export const ReconnectMcpRequestSchema = obj({ server: opt(str({ minLength: 1 })) });
export type ReconnectMcpRequest = Static<typeof ReconnectMcpRequestSchema>;

export const ReconnectMcpResponseSchema = obj({ status: arr(McpServerSnapshotSchema) });
export type ReconnectMcpResponse = Static<typeof ReconnectMcpResponseSchema>;
