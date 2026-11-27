import {
  bool,
  int,
  lit,
  map,
  nullable,
  num,
  obj,
  opt,
  type Static,
  str,
} from "@earendil-works/pi-schema";
import { ModelSlotsOverrideSchema, ToolsSettingsSchema } from "./common.ts";
import { McpServerConfigSchema } from "./mcp.ts";
import { ModelProfilesDocumentSchema } from "./providers.ts";
import { SkillPolicyMapSchema } from "./skills.ts";

export const EngineSettingsSchema = obj({
  maxActiveWorkers: opt(int({ minimum: 0 })),
  backgroundAfterMs: opt(int({ minimum: 0 })),
  routerContextTokens: opt(int({ minimum: 1 })),
  idleHibernateMs: opt(int({ minimum: 0 })),
  models: opt(ModelSlotsOverrideSchema),
  tools: opt(ToolsSettingsSchema),
});
export type EngineSettings = Static<typeof EngineSettingsSchema>;

export const ConfigBundleSchema = obj({
  version: lit(1),
  settings: EngineSettingsSchema,
  modelProfiles: ModelProfilesDocumentSchema,
  mcpServers: map(McpServerConfigSchema),
  skillsPolicy: opt(SkillPolicyMapSchema),
  modelsConfig: opt(obj({}, { open: true })),
});
export type ConfigBundle = Static<typeof ConfigBundleSchema>;

export const WebSessionResponseSchema = obj({ authenticated: bool() });
export type WebSessionResponse = Static<typeof WebSessionResponseSchema>;

export const CreateWebSessionRequestSchema = obj({
  token: opt(str({ minLength: 1 })),
  ticket: opt(str({ minLength: 1 })),
});
export type CreateWebSessionRequest = Static<typeof CreateWebSessionRequestSchema>;

export const CreateWebTicketResponseSchema = obj({
  ticket: str({ minLength: 1 }),
  expiresAt: num(),
});
export type CreateWebTicketResponse = Static<typeof CreateWebTicketResponseSchema>;

export const PickDirectoryRequestSchema = obj({
  initialPath: opt(str({ minLength: 1 })),
  title: opt(str({ minLength: 1 })),
});
export type PickDirectoryRequest = Static<typeof PickDirectoryRequestSchema>;

export const PickDirectoryResponseSchema = obj({
  path: nullable(str({ minLength: 1 })),
  cancelled: bool(),
});
export type PickDirectoryResponse = Static<typeof PickDirectoryResponseSchema>;
