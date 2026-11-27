import {
  arr,
  bool,
  int,
  lit,
  map,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";
import {
  CompatFieldInfoSchema,
  ConnectionNoteSchema,
  InputModalitiesSchema,
  ModelDetailSchema,
  ModelsConfigDiagnosticSchema,
  PartialModelCostSchema,
  ThinkingLevelConfigSchema,
} from "./models.ts";

export * from "./models.ts";

export const AuthTypeSchema = oneOf(["api_key", "oauth"]);
export type AuthType = Static<typeof AuthTypeSchema>;

export const ProviderAuthMethodsSchema = obj({
  apiKey: bool(),
  apiKeyLogin: bool(),
  oauth: bool(),
  oauthName: opt(str()),
  oauthLabel: opt(str()),
});
export type ProviderAuthMethods = Static<typeof ProviderAuthMethodsSchema>;

export const PROVIDER_SUMMARY_FIELDS = {
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  baseUrl: opt(str()),
  authMethods: ProviderAuthMethodsSchema,
  configured: bool(),
  authType: opt(AuthTypeSchema),
  authSource: opt(str()),
  modelCount: int({ minimum: 0 }),
  kind: opt(oneOf(["builtin", "custom"])),
  api: opt(str()),
  hasConfigOverride: opt(bool()),
  customModelCount: opt(int({ minimum: 0 })),
  overrideCount: opt(int({ minimum: 0 })),
  authPreview: opt(str()),
  authAccountLabel: opt(str()),
  authExpiresAt: opt(num()),
} as const;

export const ProviderSummarySchema = obj(PROVIDER_SUMMARY_FIELDS);
export type ProviderSummary = Static<typeof ProviderSummarySchema>;

export const ListProvidersResponseSchema = obj({
  providers: arr(ProviderSummarySchema),
  diagnostics: opt(arr(ModelsConfigDiagnosticSchema)),
});
export type ListProvidersResponse = Static<typeof ListProvidersResponseSchema>;

export const SetApiKeyRequestSchema = obj({ key: opt(str()), env: opt(map(str())) });
export type SetApiKeyRequest = Static<typeof SetApiKeyRequestSchema>;

export const StartLoginRequestSchema = obj({ type: AuthTypeSchema });
export type StartLoginRequest = Static<typeof StartLoginRequestSchema>;

export const StartLoginResponseSchema = obj({
  sessionId: str({ minLength: 1 }),
  providerId: str({ minLength: 1 }),
  type: AuthTypeSchema,
});
export type StartLoginResponse = Static<typeof StartLoginResponseSchema>;

export const LoginInputRequestSchema = obj({
  promptId: str({ minLength: 1 }),
  value: str(),
});
export type LoginInputRequest = Static<typeof LoginInputRequestSchema>;

export const LoginAuthInfoLinkSchema = obj({ url: str(), label: opt(str()) });
export type LoginAuthInfoLink = Static<typeof LoginAuthInfoLinkSchema>;

export const LoginAuthEventSchema = union([
  obj({ type: lit("info"), message: str(), links: opt(arr(LoginAuthInfoLinkSchema)) }),
  obj({ type: lit("auth_url"), url: str(), instructions: opt(str()) }),
  obj({
    type: lit("device_code"),
    userCode: str(),
    verificationUri: str(),
    openBrowserOnConfirm: opt(bool()),
    copyCodeOnConfirm: opt(bool()),
    intervalSeconds: opt(num()),
    expiresInSeconds: opt(num()),
  }),
  obj({ type: lit("progress"), message: str() }),
]);
export type LoginAuthEvent = Static<typeof LoginAuthEventSchema>;

export const LoginPromptOptionSchema = obj({
  id: str(),
  label: str(),
  description: opt(str()),
});
export type LoginPromptOption = Static<typeof LoginPromptOptionSchema>;

export const LoginPromptEventSchema = union([
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("text"),
    message: str(),
    placeholder: opt(str()),
  }),
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("secret"),
    message: str(),
    placeholder: opt(str()),
  }),
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("select"),
    message: str(),
    options: arr(LoginPromptOptionSchema),
  }),
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("manual_code"),
    message: str(),
    placeholder: opt(str()),
  }),
]);
export type LoginPromptEvent = Static<typeof LoginPromptEventSchema>;

export const LoginCompleteEventSchema = obj({
  providerId: str({ minLength: 1 }),
  type: AuthTypeSchema,
});
export type LoginCompleteEvent = Static<typeof LoginCompleteEventSchema>;

export const LoginErrorEventSchema = obj({
  code: str({ minLength: 1 }),
  message: str({ minLength: 1 }),
});
export type LoginErrorEvent = Static<typeof LoginErrorEventSchema>;

export const BuiltinProviderCatalogItemSchema = obj({
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  baseUrl: opt(str()),
  apis: arr(str()),
  modelCount: int({ minimum: 0 }),
  configured: bool(),
  hasConfigOverride: bool(),
  authMethods: ProviderAuthMethodsSchema,
});
export type BuiltinProviderCatalogItem = Static<typeof BuiltinProviderCatalogItemSchema>;

export const ProviderCatalogResponseSchema = obj({
  providers: arr(BuiltinProviderCatalogItemSchema),
  supportedApis: arr(str()),
  compatSchemas: map(arr(CompatFieldInfoSchema)),
});
export type ProviderCatalogResponse = Static<typeof ProviderCatalogResponseSchema>;

export const ProviderDetailSchema = obj({
  ...PROVIDER_SUMMARY_FIELDS,
  config: opt(
    obj({
      name: opt(str()),
      baseUrl: opt(str()),
      api: opt(str()),
      authHeader: opt(bool()),
      oauth: opt(lit("radius")),
      hasApiKey: opt(bool()),
      apiKeyRef: opt(str()),
      headers: opt(map(str())),
      compat: opt(obj({}, { open: true })),
    }),
  ),
  connectionNote: opt(ConnectionNoteSchema),
  models: arr(ModelDetailSchema),
});
export type ProviderDetail = Static<typeof ProviderDetailSchema>;

export const ProviderDetailResponseSchema = obj({ provider: ProviderDetailSchema });
export type ProviderDetailResponse = Static<typeof ProviderDetailResponseSchema>;

export const UpsertProviderRequestSchema = obj({
  id: opt(str()),
  name: opt(nullable(str())),
  baseUrl: opt(nullable(str())),
  api: opt(nullable(str())),
  apiKey: opt(nullable(str())),
  authHeader: opt(nullable(bool())),
  oauth: opt(nullable(lit("radius"))),
  headers: opt(nullable(map(str()))),
  compat: opt(nullable(obj({}, { open: true }))),
  models: opt(arr(obj({}, { open: true }))),
});
export type UpsertProviderRequest = Static<typeof UpsertProviderRequestSchema>;

export const UpsertProviderModelRequestSchema = obj({
  id: opt(str()),
  name: opt(nullable(str())),
  api: opt(nullable(str())),
  baseUrl: opt(nullable(str())),
  reasoning: opt(nullable(bool())),
  thinkingLevels: opt(nullable(ThinkingLevelConfigSchema)),
  input: opt(nullable(InputModalitiesSchema)),
  contextWindow: opt(nullable(num({ minimum: 0 }))),
  maxTokens: opt(nullable(num({ minimum: 0 }))),
  cost: opt(nullable(PartialModelCostSchema)),
  promptCache: opt(nullable(obj({}, { open: true }))),
  inputLimits: opt(nullable(obj({}, { open: true }))),
  samplingParams: opt(nullable(obj({}, { open: true }))),
  samplingParamsByThinkingLevel: opt(nullable(obj({}, { open: true }))),
  headers: opt(nullable(map(str()))),
  compat: opt(nullable(obj({}, { open: true }))),
});
export type UpsertProviderModelRequest = Static<typeof UpsertProviderModelRequestSchema>;

export const ProbeProviderRequestSchema = obj({
  baseUrl: opt(str()),
  api: opt(str()),
  apiKey: opt(str()),
  headers: opt(map(str())),
  authHeader: opt(bool()),
});
export type ProbeProviderRequest = Static<typeof ProbeProviderRequestSchema>;

export const ProbedModelSchema = obj({
  id: str({ minLength: 1 }),
  name: opt(str()),
  contextWindow: opt(num({ minimum: 0 })),
  maxTokens: opt(num({ minimum: 0 })),
  input: opt(InputModalitiesSchema),
  reasoning: opt(bool()),
  exists: bool(),
});
export type ProbedModel = Static<typeof ProbedModelSchema>;

export const ProbeProviderResponseSchema = obj({
  ok: bool(),
  catalogUrl: opt(str()),
  connectionNote: opt(ConnectionNoteSchema),
  models: arr(ProbedModelSchema),
  truncated: bool(),
  error: opt(str()),
});
export type ProbeProviderResponse = Static<typeof ProbeProviderResponseSchema>;

export const ImportProviderModelsRequestSchema = obj({
  models: arr(
    obj({
      id: str({ minLength: 1 }),
      name: opt(str()),
      contextWindow: opt(num({ minimum: 0 })),
      maxTokens: opt(num({ minimum: 0 })),
      input: opt(InputModalitiesSchema),
      reasoning: opt(bool()),
      api: opt(str()),
      baseUrl: opt(str()),
    }),
  ),
});
export type ImportProviderModelsRequest = Static<typeof ImportProviderModelsRequestSchema>;

export const ImportProviderModelsResponseSchema = obj({
  imported: int({ minimum: 0 }),
  provider: ProviderDetailSchema,
});
export type ImportProviderModelsResponse = Static<typeof ImportProviderModelsResponseSchema>;
