import {
  MCP_EXPOSURES,
  type McpExposure,
  McpExposureSchema,
  type McpServerSnapshotPayload,
  type McpServerStatusPayload,
  validateWithSchema,
} from "@eevee/protocol";
import { deepEqualJson, isRecord } from "../../../lib/object.ts";
import { type HeaderRow, headersToRows, rowsToHeaders } from "../header-rows.ts";

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const DEFAULT_EXPOSURE: McpExposure = "codemode";

const EXPOSURE_LABELS: Readonly<Record<McpExposure, string>> = {
  codemode: "codemode（默认 · 代码沙盒调用）",
  deferred: "deferred（按需搜索发现）",
  direct: "direct（直接注入上下文）",
  hidden: "hidden（对模型隐藏）",
};

const EXPOSURE_PRIORITY: Readonly<Record<McpExposure, number>> = {
  codemode: 0,
  deferred: 1,
  direct: 2,
  hidden: 3,
};

export const EXPOSURE_OPTIONS: readonly { readonly value: McpExposure; readonly label: string }[] =
  [...MCP_EXPOSURES]
    .sort((a, b) => EXPOSURE_PRIORITY[a] - EXPOSURE_PRIORITY[b])
    .map((value) => ({ value, label: EXPOSURE_LABELS[value] }));

export type TransportKind = "stdio" | "http";
export type OAuthClientRegistration = "" | "auto" | "dcr" | "cimd";

export type ServerFormState = {
  readonly mode: "create" | "edit";
  readonly originalName?: string;
  readonly name: string;
  readonly transport: TransportKind;
  readonly enabled: boolean;
  readonly description: string;
  readonly command: string;
  readonly argsText: string;
  readonly cwd: string;
  readonly envRows: HeaderRow[];
  readonly url: string;
  readonly headerRows: HeaderRow[];
  readonly timeoutText: string;
  readonly exposure: McpExposure;
  readonly roleRouter: boolean;
  readonly roleWorker: boolean;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly oauthScope: string;
  readonly oauthCallbackPort: string;
  readonly oauthCallbackUrl: string;
  readonly oauthClientName: string;
  readonly oauthClientRegistration: OAuthClientRegistration;
  readonly oauthAuthServerMetadataUrl: string;
  readonly oauthAdvancedOpen: boolean;
};

export type ServerLogsState = {
  readonly loading: boolean;
  readonly lines: readonly string[];
  readonly logPath?: string;
  readonly error?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function normalizeExposure(value: unknown): McpExposure {
  if (value === "codemode-deferred") return "codemode";
  const parsed = validateWithSchema(McpExposureSchema, value);
  return parsed.ok ? parsed.value : DEFAULT_EXPOSURE;
}

export function getExplicitToolExposure(
  config: Record<string, unknown> | undefined,
): Record<string, McpExposure> {
  if (!config || !isRecord(config.toolExposure)) return {};
  const out: Record<string, McpExposure> = {};
  for (const [tool, raw] of Object.entries(config.toolExposure)) {
    if (typeof raw === "string") out[tool] = normalizeExposure(raw);
  }
  return out;
}

export function isOverrideEntry(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false;
  return config.command === undefined && config.url === undefined && config.type === undefined;
}

export function statusMeta(status: McpServerStatusPayload): {
  readonly label: string;
  readonly stage: "done" | "working" | "queued" | "answer" | "blocked" | "idle";
  readonly tone?: "positive" | "warning" | "negative" | "info" | "muted";
} {
  switch (status) {
    case "connected":
      return { label: "已连接", stage: "done", tone: "positive" };
    case "connecting":
      return { label: "连接中", stage: "working" };
    case "idle":
      return { label: "空闲", stage: "queued" };
    case "auth_required":
      return { label: "需 OAuth 授权", stage: "answer", tone: "warning" };
    case "degraded":
      return { label: "降级运行", stage: "answer", tone: "warning" };
    case "disconnected":
      return { label: "已断开", stage: "idle", tone: "warning" };
    case "failed":
      return { label: "连接失败", stage: "blocked", tone: "negative" };
    case "disabled":
      return { label: "已禁用", stage: "idle", tone: "muted" };
    case "closed":
      return { label: "已关闭", stage: "idle", tone: "muted" };
  }
}

export function scopeBadge(scope: McpServerSnapshotPayload["scope"]): {
  readonly label: string;
  readonly tone?: "info" | "warning";
} | null {
  if (scope === "project") return { label: "项目", tone: "info" };
  if (scope === "override") return { label: "项目覆盖", tone: "warning" };
  if (scope === "global") return { label: "全局" };
  return null;
}

export function createBlankForm(): ServerFormState {
  return {
    mode: "create",
    name: "",
    transport: "stdio",
    enabled: true,
    description: "",
    command: "",
    argsText: "",
    cwd: "",
    envRows: [],
    url: "",
    headerRows: [],
    timeoutText: "",
    exposure: DEFAULT_EXPOSURE,
    roleRouter: true,
    roleWorker: true,
    oauthClientId: "",
    oauthClientSecret: "",
    oauthScope: "",
    oauthCallbackPort: "",
    oauthCallbackUrl: "",
    oauthClientName: "",
    oauthClientRegistration: "",
    oauthAuthServerMetadataUrl: "",
    oauthAdvancedOpen: false,
  };
}

export function formFromConfig(
  name: string,
  config: Record<string, unknown> | undefined,
  snapshot: McpServerSnapshotPayload | undefined,
): ServerFormState {
  const isHttp =
    typeof config?.url === "string" ||
    config?.type === "http" ||
    (config?.command === undefined && snapshot?.transport === "http");
  const roles = isRecord(config?.roles) ? config.roles : undefined;
  const oauth = isRecord(config?.oauth) ? config.oauth : undefined;
  const reg = asString(oauth?.clientRegistration);
  const clientRegistration: OAuthClientRegistration =
    reg === "auto" || reg === "dcr" || reg === "cimd" ? reg : "";

  return {
    mode: "edit",
    originalName: name,
    name,
    transport: isHttp ? "http" : "stdio",
    enabled: config?.enabled !== undefined ? config.enabled !== false : (snapshot?.enabled ?? true),
    description: asString(config?.description) ?? snapshot?.description ?? "",
    command: asString(config?.command) ?? "",
    argsText: (asStringArray(config?.args) ?? []).join("\n"),
    cwd: asString(config?.cwd) ?? "",
    envRows: headersToRows(asStringMap(config?.env)),
    url: asString(config?.url) ?? "",
    headerRows: headersToRows(asStringMap(config?.headers)),
    timeoutText: asNumber(config?.timeout) !== undefined ? String(config?.timeout) : "",
    exposure:
      config?.exposure !== undefined
        ? normalizeExposure(config.exposure)
        : (snapshot?.exposure ?? DEFAULT_EXPOSURE),
    roleRouter:
      roles?.router !== undefined ? roles.router !== false : (snapshot?.roles?.router ?? true),
    roleWorker:
      roles?.worker !== undefined ? roles.worker !== false : (snapshot?.roles?.worker ?? true),
    oauthClientId: asString(oauth?.clientId) ?? "",
    oauthClientSecret: asString(oauth?.clientSecret) ?? "",
    oauthScope: asString(oauth?.scope) ?? "",
    oauthCallbackPort:
      asNumber(oauth?.callbackPort) !== undefined ? String(oauth?.callbackPort) : "",
    oauthCallbackUrl: asString(oauth?.callbackUrl) ?? "",
    oauthClientName: asString(oauth?.clientName) ?? "",
    oauthClientRegistration: clientRegistration,
    oauthAuthServerMetadataUrl: asString(oauth?.authServerMetadataUrl) ?? "",
    oauthAdvancedOpen: oauth !== undefined && Object.keys(oauth).length > 0,
  };
}

export function validateServerName(rawName: string): string {
  const serverName = rawName.trim();
  if (!serverName) {
    throw new Error("请填写服务名称。");
  }
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error("服务名称只能包含字母、数字、下划线（_）和连字符（-）。");
  }
  return serverName;
}

export function buildConfigFromForm(
  form: ServerFormState,
  existingConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const timeoutRaw = form.timeoutText.trim();
  let timeout: number | undefined;
  if (timeoutRaw !== "") {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("超时时间（秒）必须是大于 0 的数字。");
    }
    timeout = parsed;
  }

  const description = form.description.trim();
  const existingToolExposure = getExplicitToolExposure(existingConfig);
  const base: Record<string, unknown> = {
    enabled: form.enabled,
    ...(description ? { description } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    exposure: form.exposure,
    roles: {
      router: form.roleRouter,
      worker: form.roleWorker,
    },
    ...(Object.keys(existingToolExposure).length > 0 ? { toolExposure: existingToolExposure } : {}),
  };

  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (!command) throw new Error("请填写 stdio 启动命令（command）。");
    const args = form.argsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const cwd = form.cwd.trim();
    const env = rowsToHeaders(form.envRows, "环境变量");
    return {
      ...base,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
    };
  }

  const url = form.url.trim();
  if (!url) throw new Error("请填写 HTTP 服务 URL。");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("URL 格式无效。");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("HTTP 服务 URL 必须以 http:// 或 https:// 开头。");
  }
  const headers = rowsToHeaders(form.headerRows, "请求头");

  const oauth: Record<string, unknown> = {};
  if (form.oauthClientId.trim()) oauth.clientId = form.oauthClientId.trim();
  if (form.oauthClientSecret.trim()) oauth.clientSecret = form.oauthClientSecret.trim();
  if (form.oauthScope.trim()) oauth.scope = form.oauthScope.trim();
  if (form.oauthCallbackPort.trim()) {
    const port = Number(form.oauthCallbackPort.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("OAuth callbackPort 必须是 1~65535 的整数。");
    }
    oauth.callbackPort = port;
  }
  if (form.oauthCallbackUrl.trim()) oauth.callbackUrl = form.oauthCallbackUrl.trim();
  if (form.oauthClientName.trim()) oauth.clientName = form.oauthClientName.trim();
  if (form.oauthClientRegistration !== "") {
    oauth.clientRegistration = form.oauthClientRegistration;
  }
  if (form.oauthAuthServerMetadataUrl.trim()) {
    oauth.authServerMetadataUrl = form.oauthAuthServerMetadataUrl.trim();
  }

  return {
    ...base,
    url,
    ...(headers ? { headers } : {}),
    ...(Object.keys(oauth).length > 0 ? { oauth } : {}),
  };
}

export function connectionFieldsMatch(
  candidate: Record<string, unknown>,
  globalEntry: Record<string, unknown>,
): boolean {
  const keys = [
    "command",
    "args",
    "cwd",
    "env",
    "url",
    "headers",
    "oauth",
    "timeout",
    "description",
  ];
  const candidateTransport = typeof candidate.url === "string" ? "http" : "stdio";
  const globalTransport = typeof globalEntry.url === "string" ? "http" : "stdio";
  if (candidateTransport !== globalTransport) return false;
  return keys.every((key) => deepEqualJson(candidate[key], globalEntry[key]));
}

export function targetSummary(config: Record<string, unknown> | undefined): string | undefined {
  if (!config) return undefined;
  if (typeof config.url === "string") return config.url;
  if (typeof config.command === "string") {
    const args = asStringArray(config.args) ?? [];
    return args.length > 0 ? `${config.command} ${args.join(" ")}` : config.command;
  }
  return undefined;
}

export function normalizeServerMap(
  raw: Readonly<Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v)) out[k] = v;
  }
  return out;
}

export function parseImportJson(rawText: string): Record<string, Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("JSON 根节点必须是对象（{ mcpServers: { ... } } 或服务映射对象）。");
  }
  const source = "mcpServers" in parsed ? parsed.mcpServers : parsed;
  if (!isRecord(source)) {
    throw new Error("mcpServers 字段必须是对象。");
  }
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(source)) {
    if (!isRecord(entry)) {
      throw new Error(`服务「${name}」的配置必须是 JSON 对象。`);
    }
    servers[name] = entry;
  }
  return servers;
}
