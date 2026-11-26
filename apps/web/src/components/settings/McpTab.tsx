import {
  AddIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  KeyIcon,
  LogoutIcon,
  OpenInNewIcon,
  RefreshIcon,
  TerminalIcon,
  UndoIcon,
  UploadIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  Checkbox,
  Field,
  Heading,
  IconButton,
  Input,
  Link,
  SegmentedControl,
  Switch,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import type {
  McpExposure,
  McpOAuthEvent,
  McpServerSnapshotPayload,
  McpServerStatusPayload,
  McpStateResponse,
  ProjectMcpStateResponse,
} from "@eevee/protocol";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";
import { type HeaderRow, HeadersEditor, headersToRows, rowsToHeaders } from "./HeadersEditor.tsx";

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_EXPOSURE: McpExposure = "codemode";
const EXPOSURE_OPTIONS: readonly { readonly value: McpExposure; readonly label: string }[] = [
  { value: "codemode", label: "codemode（默认 · 代码沙盒调用）" },
  { value: "deferred", label: "deferred（按需搜索发现）" },
  { value: "direct", label: "direct（直接注入上下文）" },
  { value: "hidden", label: "hidden（对模型隐藏）" },
];

type TransportKind = "stdio" | "http";

type ServerFormState = {
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
  readonly oauthClientRegistration: "" | "auto" | "dcr" | "cimd";
  readonly oauthAuthServerMetadataUrl: string;
  readonly oauthAdvancedOpen: boolean;
};

type OAuthProgressEntry = {
  readonly id: number;
  readonly message: string;
};

let nextOAuthProgressId = 1;

type OAuthUiSession = {
  readonly serverName: string;
  readonly sessionId: string;
  readonly authUrl?: string;
  readonly redirectHint?: string;
  readonly instructions?: string;
  readonly progress: readonly OAuthProgressEntry[];
  readonly redirectInput: string;
  readonly submittingInput: boolean;
  readonly done: boolean;
  readonly error?: string;
};

type ServerLogsState = {
  readonly loading: boolean;
  readonly lines: readonly string[];
  readonly logPath?: string;
  readonly error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function normalizeExposure(value: unknown): McpExposure {
  if (value === "codemode-deferred") return "codemode";
  if (value === "codemode" || value === "deferred" || value === "direct" || value === "hidden") {
    return value;
  }
  return DEFAULT_EXPOSURE;
}

function getExplicitToolExposure(
  config: Record<string, unknown> | undefined,
): Record<string, McpExposure> {
  if (!config || !isRecord(config.toolExposure)) return {};
  const out: Record<string, McpExposure> = {};
  for (const [tool, raw] of Object.entries(config.toolExposure)) {
    if (typeof raw === "string") out[tool] = normalizeExposure(raw);
  }
  return out;
}

function isOverrideEntry(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false;
  return config.command === undefined && config.url === undefined && config.type === undefined;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => deepEqualJson(item, b[idx]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(b, k) && deepEqualJson(a[k], b[k]));
  }
  return false;
}

function statusMeta(status: McpServerStatusPayload): {
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

function scopeBadge(scope: McpServerSnapshotPayload["scope"]): {
  readonly label: string;
  readonly tone?: "info" | "warning";
} | null {
  if (scope === "project") return { label: "项目", tone: "info" };
  if (scope === "override") return { label: "项目覆盖", tone: "warning" };
  if (scope === "global") return { label: "全局" };
  return null;
}

function createBlankForm(): ServerFormState {
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

function formFromConfig(
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
  const clientRegistration = reg === "auto" || reg === "dcr" || reg === "cimd" ? reg : "";

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

function buildConfigFromForm(
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

function connectionFieldsMatch(
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

function targetSummary(config: Record<string, unknown> | undefined): string | undefined {
  if (!config) return undefined;
  if (typeof config.url === "string") return config.url;
  if (typeof config.command === "string") {
    const args = asStringArray(config.args) ?? [];
    return args.length > 0 ? `${config.command} ${args.join(" ")}` : config.command;
  }
  return undefined;
}

function normalizeServerMap(
  raw: Readonly<Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v)) out[k] = v;
  }
  return out;
}

function parseImportJson(rawText: string): Record<string, Record<string, unknown>> {
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

export function McpTab({
  projectId,
  compact = false,
}: {
  readonly projectId?: string;
  readonly compact?: boolean;
}) {
  const idPrefix = useId();
  const [globalState, setGlobalState] = useState<McpStateResponse | undefined>(undefined);
  const [projectState, setProjectState] = useState<ProjectMcpStateResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectingServer, setReconnectingServer] = useState<string | undefined>(undefined);
  const [mutatingServers, setMutatingServers] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const [formState, setFormState] = useState<ServerFormState | undefined>(undefined);
  const [savingForm, setSavingForm] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const [jsonPanelOpen, setJsonPanelOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [importingJson, setImportingJson] = useState(false);
  const [jsonError, setJsonError] = useState<string | undefined>(undefined);

  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [openLogs, setOpenLogs] = useState<Record<string, boolean>>({});
  const [logsByServer, setLogsByServer] = useState<Record<string, ServerLogsState>>({});

  const [oauthSession, setOauthSession] = useState<OAuthUiSession | undefined>(undefined);
  const oauthAbortRef = useRef<AbortController | undefined>(undefined);
  const loadAbortRef = useRef<AbortController | undefined>(undefined);

  const applyState = useCallback(
    (next: McpStateResponse | ProjectMcpStateResponse) => {
      if (projectId) {
        setProjectState(next as ProjectMcpStateResponse);
      } else {
        setGlobalState(next as McpStateResponse);
      }
    },
    [projectId],
  );

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      if (projectId) {
        const res = await api.getProjectMcpState(projectId, controller.signal);
        if (!controller.signal.aborted) setProjectState(res);
      } else {
        const res = await api.getMcpState(controller.signal);
        if (!controller.signal.aborted) setGlobalState(res);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setFormState(undefined);
    setJsonPanelOpen(false);
    setOpenTools({});
    setOpenLogs({});
    setLogsByServer({});
    oauthAbortRef.current?.abort();
    setOauthSession(undefined);
    void load();
    return () => {
      loadAbortRef.current?.abort();
      oauthAbortRef.current?.abort();
    };
  }, [load]);

  const statuses: readonly McpServerSnapshotPayload[] = projectId
    ? (projectState?.status ?? [])
    : (globalState?.status ?? []);

  const globalServers = normalizeServerMap(
    projectId ? projectState?.globalServers : globalState?.servers,
  );
  const projectServers = normalizeServerMap(projectId ? projectState?.projectServers : undefined);
  const effectiveServers = normalizeServerMap(
    projectId ? projectState?.effectiveServers : globalState?.servers,
  );

  const upsertConfig = async (
    serverName: string,
    config: Record<string, unknown>,
  ): Promise<void> => {
    setMutatingServers((prev) => ({ ...prev, [serverName]: true }));
    setError(undefined);
    try {
      const next = projectId
        ? await api.upsertProjectMcpServer(projectId, serverName, { config })
        : await api.upsertMcpServer(serverName, { config });
      applyState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingServers((prev) => {
        const copy = { ...prev };
        delete copy[serverName];
        return copy;
      });
    }
  };

  const patchServer = async (
    srv: McpServerSnapshotPayload,
    patch: Record<string, unknown>,
  ): Promise<void> => {
    if (!projectId) {
      const base = globalServers[srv.name] ?? {};
      await upsertConfig(srv.name, { ...base, ...patch });
      return;
    }

    if (srv.scope === "project") {
      const base = projectServers[srv.name] ?? effectiveServers[srv.name] ?? {};
      await upsertConfig(srv.name, { ...base, ...patch });
      return;
    }

    const existingOverride = projectServers[srv.name];
    const base = existingOverride ?? {};
    const merged: Record<string, unknown> = { ...base, ...patch };
    if (isRecord(base.roles) && isRecord(patch.roles)) {
      merged.roles = { ...base.roles, ...patch.roles };
    }
    await upsertConfig(srv.name, merged);
  };

  const handleToggleEnabled = (srv: McpServerSnapshotPayload, enabled: boolean) => {
    void patchServer(srv, { enabled });
  };

  const handleToggleRole = (
    srv: McpServerSnapshotPayload,
    role: "router" | "worker",
    checked: boolean,
  ) => {
    const currentRouter = srv.roles?.router !== false;
    const currentWorker = srv.roles?.worker !== false;
    const nextRoles = {
      router: role === "router" ? checked : currentRouter,
      worker: role === "worker" ? checked : currentWorker,
    };
    void patchServer(srv, { roles: nextRoles });
  };

  const handleToolExposureChange = async (
    srv: McpServerSnapshotPayload,
    toolName: string,
    nextValue: string,
  ) => {
    const base = projectId ? (projectServers[srv.name] ?? {}) : (globalServers[srv.name] ?? {});
    const currentMap = { ...getExplicitToolExposure(base) };
    if (nextValue === "") {
      delete currentMap[toolName];
    } else {
      currentMap[toolName] = normalizeExposure(nextValue);
    }

    const nextConfig = { ...base };
    if (Object.keys(currentMap).length > 0) {
      nextConfig.toolExposure = currentMap;
    } else {
      delete nextConfig.toolExposure;
    }

    if (
      projectId &&
      srv.scope !== "project" &&
      isOverrideEntry(nextConfig) &&
      Object.keys(nextConfig).length === 0
    ) {
      if (Object.hasOwn(projectServers, srv.name)) {
        await removeOrRevert(srv);
      }
      return;
    }

    await upsertConfig(srv.name, nextConfig);
  };

  const reconnect = async (server?: string) => {
    if (server) setReconnectingServer(server);
    else setReconnecting(true);
    setError(undefined);
    try {
      if (projectId) {
        await api.reconnectProjectMcp(projectId, server ? { server } : {});
      } else {
        await api.reconnectMcp(server ? { server } : {});
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnecting(false);
      setReconnectingServer(undefined);
    }
  };

  const removeOrRevert = async (srv: McpServerSnapshotPayload) => {
    setMutatingServers((prev) => ({ ...prev, [srv.name]: true }));
    setError(undefined);
    try {
      const next = projectId
        ? await api.deleteProjectMcpServer(projectId, srv.name)
        : await api.deleteMcpServer(srv.name);
      applyState(next);
      if (formState?.originalName === srv.name) setFormState(undefined);
      showToast(
        projectId && srv.scope === "override"
          ? `已恢复「${srv.name}」为全局配置`
          : `已删除 MCP 服务「${srv.name}」`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingServers((prev) => {
        const copy = { ...prev };
        delete copy[srv.name];
        return copy;
      });
    }
  };

  const openCreateForm = () => {
    setFormError(undefined);
    setFormState(createBlankForm());
  };

  const openEditForm = (srv: McpServerSnapshotPayload) => {
    setFormError(undefined);
    const config = effectiveServers[srv.name] ?? globalServers[srv.name];
    setFormState(formFromConfig(srv.name, config, srv));
  };

  const handleFormSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!formState) return;
    const serverName = formState.name.trim();
    if (!serverName) {
      setFormError("请填写服务名称。");
      return;
    }
    if (!SERVER_NAME_RE.test(serverName)) {
      setFormError("服务名称只能包含字母、数字、下划线（_）和连字符（-）。");
      return;
    }

    setSavingForm(true);
    setFormError(undefined);
    try {
      const existingConfig =
        formState.mode === "edit"
          ? (effectiveServers[serverName] ?? globalServers[serverName])
          : undefined;
      const fullConfig = buildConfigFromForm(formState, existingConfig);

      let payloadConfig = fullConfig;
      if (projectId && formState.mode === "edit" && Object.hasOwn(globalServers, serverName)) {
        const globalEntry = globalServers[serverName];
        const existingProject = projectServers[serverName];
        if (
          globalEntry &&
          (existingProject === undefined || isOverrideEntry(existingProject)) &&
          connectionFieldsMatch(fullConfig, globalEntry)
        ) {
          const overrideToolExposure = getExplicitToolExposure(existingProject);
          payloadConfig = {
            enabled: formState.enabled,
            exposure: formState.exposure,
            roles: {
              router: formState.roleRouter,
              worker: formState.roleWorker,
            },
            ...(Object.keys(overrideToolExposure).length > 0
              ? { toolExposure: overrideToolExposure }
              : {}),
          };
        }
      }

      const next = projectId
        ? await api.upsertProjectMcpServer(projectId, serverName, { config: payloadConfig })
        : await api.upsertMcpServer(serverName, { config: payloadConfig });
      applyState(next);
      setFormState(undefined);
      showToast(
        formState.mode === "create"
          ? `已添加 MCP 服务「${serverName}」`
          : `已更新「${serverName}」`,
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingForm(false);
    }
  };

  const openJsonPanel = () => {
    setJsonError(undefined);
    const source = projectId ? projectServers : globalServers;
    setJsonText(JSON.stringify({ mcpServers: source }, null, 2));
    setJsonPanelOpen((prev) => !prev);
  };

  const handleImportJson = async () => {
    setImportingJson(true);
    setJsonError(undefined);
    try {
      const servers = parseImportJson(jsonText);
      const next = projectId
        ? await api.putProjectMcpConfig(projectId, { servers })
        : await api.putMcpConfig({ servers });
      applyState(next);
      setJsonPanelOpen(false);
      showToast(projectId ? "已导入项目 MCP 配置" : "已导入全局 MCP 配置");
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingJson(false);
    }
  };

  const fetchLogs = async (serverName: string) => {
    setLogsByServer((prev) => ({
      ...prev,
      [serverName]: {
        loading: true,
        lines: prev[serverName]?.lines ?? [],
        logPath: prev[serverName]?.logPath,
      },
    }));
    try {
      const res = projectId
        ? await api.getProjectMcpLogs(projectId, serverName)
        : await api.getMcpLogs(serverName);
      setLogsByServer((prev) => ({
        ...prev,
        [serverName]: { loading: false, lines: res.lines, logPath: res.logPath },
      }));
    } catch (err) {
      setLogsByServer((prev) => ({
        ...prev,
        [serverName]: {
          loading: false,
          lines: prev[serverName]?.lines ?? [],
          logPath: prev[serverName]?.logPath,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  const toggleLogs = (srv: McpServerSnapshotPayload) => {
    const nextOpen = !openLogs[srv.name];
    setOpenLogs((prev) => ({ ...prev, [srv.name]: nextOpen }));
    if (nextOpen) {
      void fetchLogs(srv.name);
    }
  };

  const startOAuth = async (serverName: string) => {
    oauthAbortRef.current?.abort();
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    setError(undefined);
    try {
      const started = await api.startMcpOAuth(serverName, controller.signal);
      setOauthSession({
        serverName,
        sessionId: started.sessionId,
        progress: [],
        redirectInput: "",
        submittingInput: false,
        done: false,
      });

      for await (const event of api.streamMcpOAuth(serverName, started.sessionId, {
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        const ev: McpOAuthEvent = event;
        if (ev.type === "auth_url") {
          setOauthSession((prev) =>
            prev && prev.sessionId === started.sessionId
              ? {
                  ...prev,
                  authUrl: ev.url,
                  redirectHint: ev.redirectUrl,
                  instructions: ev.instructions,
                }
              : prev,
          );
        } else if (ev.type === "progress") {
          setOauthSession((prev) =>
            prev && prev.sessionId === started.sessionId
              ? {
                  ...prev,
                  progress: [...prev.progress, { id: nextOAuthProgressId++, message: ev.message }],
                }
              : prev,
          );
        } else if (ev.type === "complete") {
          setOauthSession((prev) =>
            prev && prev.sessionId === started.sessionId ? { ...prev, done: true } : prev,
          );
          showToast(`${serverName} OAuth 登录成功`);
          await load();
        } else if (ev.type === "error") {
          setOauthSession((prev) =>
            prev && prev.sessionId === started.sessionId ? { ...prev, error: ev.message } : prev,
          );
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setOauthSession((prev) =>
          prev && prev.serverName === serverName ? { ...prev, error: msg } : prev,
        );
        setError(msg);
      }
    }
  };

  const submitOAuthRedirect = async () => {
    if (!oauthSession) return;
    const redirectUrl = oauthSession.redirectInput.trim();
    if (!redirectUrl) return;
    setOauthSession((prev) => (prev ? { ...prev, submittingInput: true, error: undefined } : prev));
    try {
      await api.submitMcpOAuthInput(oauthSession.serverName, oauthSession.sessionId, {
        redirectUrl,
      });
      setOauthSession((prev) =>
        prev
          ? {
              ...prev,
              submittingInput: false,
              redirectInput: "",
              progress: [
                ...prev.progress,
                { id: nextOAuthProgressId++, message: "已提交回调 URL，等待验证完成…" },
              ],
            }
          : prev,
      );
    } catch (err) {
      setOauthSession((prev) =>
        prev
          ? {
              ...prev,
              submittingInput: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : prev,
      );
    }
  };

  const cancelOAuth = async () => {
    if (!oauthSession) return;
    oauthAbortRef.current?.abort();
    await api
      .cancelMcpOAuth(oauthSession.serverName, oauthSession.sessionId)
      .catch(() => undefined);
    setOauthSession(undefined);
  };

  const logoutOAuth = async (serverName: string) => {
    setMutatingServers((prev) => ({ ...prev, [serverName]: true }));
    setError(undefined);
    try {
      await api.logoutMcpOAuth(serverName);
      if (oauthSession?.serverName === serverName) setOauthSession(undefined);
      await load();
      showToast(`已清除「${serverName}」的 OAuth 凭据`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingServers((prev) => {
        const copy = { ...prev };
        delete copy[serverName];
        return copy;
      });
    }
  };

  return (
    <div className="ev-settings-section">
      <div className="ev-settings-head">
        <div className="ev-skill-head-title">
          <Heading level={compact ? 3 : 2} size={compact ? 6 : 5}>
            MCP
          </Heading>
          <span className="eevee-badge ev-num">{statuses.length} 个服务</span>
          {projectId && Object.keys(projectServers).length > 0 && (
            <span className="eevee-badge ev-num" data-tone="warning">
              项目配置 {Object.keys(projectServers).length}
            </span>
          )}
        </div>
        <div className="ev-inline-actions">
          <Button
            type="button"
            hierarchy="primary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            onClick={openCreateForm}
          >
            添加服务
          </Button>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<CodeIcon width={15} height={15} />}
            onClick={openJsonPanel}
          >
            JSON 导入/导出
          </Button>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={15} height={15} />}
            pending={reconnecting || loading}
            onClick={() => void reconnect()}
          >
            全部重连
          </Button>
        </div>
      </div>

      {error && <div className="ev-error-banner">{error}</div>}

      {jsonPanelOpen && (
        <div className="ev-settings-card">
          <div className="ev-settings-head">
            <Heading level={4} size={6}>
              {projectId ? "项目 MCP JSON 导入 / 导出" : "全局 MCP JSON 导入 / 导出"}
            </Heading>
            <div className="ev-inline-actions">
              {projectId && (
                <>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    onClick={() =>
                      setJsonText(JSON.stringify({ mcpServers: projectServers }, null, 2))
                    }
                  >
                    载入项目覆盖
                  </Button>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    onClick={() =>
                      setJsonText(JSON.stringify({ mcpServers: effectiveServers }, null, 2))
                    }
                  >
                    载入生效配置
                  </Button>
                </>
              )}
              <Button
                type="button"
                hierarchy="secondary"
                density="compact"
                iconStart={<DownloadIcon width={14} height={14} />}
                onClick={() => {
                  const source = projectId ? projectServers : globalServers;
                  setJsonText(JSON.stringify({ mcpServers: source }, null, 2));
                }}
              >
                刷新导出
              </Button>
              <IconButton aria-label="关闭 JSON 面板" onClick={() => setJsonPanelOpen(false)}>
                <CloseIcon width={16} height={16} />
              </IconButton>
            </div>
          </div>
          {jsonError && <div className="ev-error-banner">{jsonError}</div>}
          <Text className="ev-inline-hint">
            支持标准 <span className="ev-mono">{'{ "mcpServers": { ... } }'}</span>{" "}
            格式或直接服务映射。导入将整体替换
            {projectId ? "当前项目的 MCP 覆盖与项目独占配置" : "全局 MCP 配置"}。
          </Text>
          <TextArea
            monospace
            rows={9}
            value={jsonText}
            onValueChange={setJsonText}
            placeholder={
              '{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'
            }
          />
          <div className="ev-inline-actions">
            <Button
              type="button"
              hierarchy="primary"
              density="compact"
              iconStart={<UploadIcon width={14} height={14} />}
              disabled={jsonText.trim().length === 0}
              pending={importingJson}
              onClick={() => void handleImportJson()}
            >
              导入并应用
            </Button>
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => setJsonPanelOpen(false)}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {formState && (
        <div className="ev-settings-card">
          <div className="ev-settings-head">
            <Heading level={4} size={6}>
              {formState.mode === "create"
                ? projectId
                  ? "添加项目 MCP 服务"
                  : "添加 MCP 服务"
                : `编辑 MCP 服务 · ${formState.name}`}
            </Heading>
            <IconButton aria-label="关闭编辑表单" onClick={() => setFormState(undefined)}>
              <CloseIcon width={16} height={16} />
            </IconButton>
          </div>

          {projectId &&
            formState.mode === "edit" &&
            Object.hasOwn(globalServers, formState.name) && (
              <div className="ev-inline-hint">
                正在编辑全局服务「{formState.name}
                」的项目配置：仅调整启用状态、暴露方式或角色时将保存为轻量项目覆盖；若修改命令或 URL
                等连接参数，将创建项目完整配置。
              </div>
            )}

          {formError && <div className="ev-error-banner">{formError}</div>}

          <form onSubmit={(event) => void handleFormSubmit(event)} className="ev-form-stack">
            <div className="ev-mcp-form-top">
              <Field.Root style={{ flex: 1, minWidth: 160 }}>
                <Field.Label>服务名</Field.Label>
                <Input
                  type="text"
                  value={formState.name}
                  disabled={formState.mode === "edit" || savingForm}
                  onValueChange={(value) =>
                    setFormState((prev) => (prev ? { ...prev, name: value } : prev))
                  }
                  placeholder="例如：github"
                />
              </Field.Root>

              <Field.Root>
                <Field.Label>传输方式</Field.Label>
                <SegmentedControl.Root
                  density="compact"
                  disabled={savingForm}
                  value={[formState.transport]}
                  onValueChange={(vals) => {
                    const next = vals[0];
                    if (next === "stdio" || next === "http") {
                      setFormState((prev) => (prev ? { ...prev, transport: next } : prev));
                    }
                  }}
                >
                  <SegmentedControl.Item value="stdio">stdio</SegmentedControl.Item>
                  <SegmentedControl.Item value="http">HTTP</SegmentedControl.Item>
                </SegmentedControl.Root>
              </Field.Root>

              <Field.Root style={{ minWidth: 210 }}>
                <Field.Label>默认暴露方式</Field.Label>
                <select
                  className="ev-select"
                  disabled={savingForm}
                  value={formState.exposure}
                  onChange={(event) => {
                    const next = normalizeExposure(event.target.value);
                    setFormState((prev) => (prev ? { ...prev, exposure: next } : prev));
                  }}
                >
                  {EXPOSURE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field.Root>
            </div>

            <div className="ev-mcp-form-toggles">
              <div className="ev-toggle-field" style={{ flex: "1 1 180px" }}>
                <label htmlFor={`${idPrefix}-form-enabled`}>启用服务</label>
                <Switch.Root
                  id={`${idPrefix}-form-enabled`}
                  checked={formState.enabled}
                  disabled={savingForm}
                  onCheckedChange={(checked) =>
                    setFormState((prev) => (prev ? { ...prev, enabled: checked } : prev))
                  }
                >
                  <Switch.Thumb />
                </Switch.Root>
              </div>

              <div className="ev-toggle-field" style={{ flex: "2 1 260px" }}>
                <span>可用角色</span>
                <div className="ev-mcp-roles-group">
                  <div className="ev-mcp-role-check">
                    <Checkbox.Root
                      id={`${idPrefix}-form-role-router`}
                      checked={formState.roleRouter}
                      disabled={savingForm}
                      onCheckedChange={(checked) =>
                        setFormState((prev) =>
                          prev ? { ...prev, roleRouter: checked === true } : prev,
                        )
                      }
                    >
                      <Checkbox.Indicator />
                    </Checkbox.Root>
                    <label htmlFor={`${idPrefix}-form-role-router`}>Router</label>
                  </div>
                  <div className="ev-mcp-role-check">
                    <Checkbox.Root
                      id={`${idPrefix}-form-role-worker`}
                      checked={formState.roleWorker}
                      disabled={savingForm}
                      onCheckedChange={(checked) =>
                        setFormState((prev) =>
                          prev ? { ...prev, roleWorker: checked === true } : prev,
                        )
                      }
                    >
                      <Checkbox.Indicator />
                    </Checkbox.Root>
                    <label htmlFor={`${idPrefix}-form-role-worker`}>Worker</label>
                  </div>
                </div>
              </div>
            </div>

            <div className="ev-settings-grid-2">
              <Field.Root>
                <Field.Label>描述（可选）</Field.Label>
                <Input
                  type="text"
                  value={formState.description}
                  disabled={savingForm}
                  onValueChange={(value) =>
                    setFormState((prev) => (prev ? { ...prev, description: value } : prev))
                  }
                  placeholder="一句话说明该服务提供的能力"
                />
              </Field.Root>

              <Field.Root>
                <Field.Label>单次请求超时（秒，可选）</Field.Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={formState.timeoutText}
                  disabled={savingForm}
                  onValueChange={(value) =>
                    setFormState((prev) => (prev ? { ...prev, timeoutText: value } : prev))
                  }
                  placeholder="默认"
                />
              </Field.Root>
            </div>

            {formState.transport === "stdio" ? (
              <>
                <div className="ev-settings-grid-2">
                  <Field.Root>
                    <Field.Label>可执行命令（command）</Field.Label>
                    <Input
                      type="text"
                      value={formState.command}
                      disabled={savingForm}
                      onValueChange={(value) =>
                        setFormState((prev) => (prev ? { ...prev, command: value } : prev))
                      }
                      placeholder="npx"
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>工作目录 cwd（可选）</Field.Label>
                    <Input
                      type="text"
                      value={formState.cwd}
                      disabled={savingForm}
                      onValueChange={(value) =>
                        setFormState((prev) => (prev ? { ...prev, cwd: value } : prev))
                      }
                      placeholder="默认继承项目工作目录"
                    />
                  </Field.Root>
                </div>

                <Field.Root>
                  <Field.Label>参数 args（每行一个，可选）</Field.Label>
                  <TextArea
                    monospace
                    rows={3}
                    value={formState.argsText}
                    disabled={savingForm}
                    onValueChange={(value) =>
                      setFormState((prev) => (prev ? { ...prev, argsText: value } : prev))
                    }
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
                  />
                </Field.Root>

                <Field.Root>
                  <Field.Label>环境变量 env（可选）</Field.Label>
                  <HeadersEditor
                    rows={formState.envRows}
                    disabled={savingForm}
                    itemLabel="环境变量"
                    emptyText="暂无自定义环境变量。"
                    addLabel="添加环境变量"
                    keyPlaceholder="ENV_NAME"
                    valuePlaceholder="VALUE（支持 $ENV_VAR 或 !cmd）"
                    onChange={(envRows) =>
                      setFormState((prev) => (prev ? { ...prev, envRows } : prev))
                    }
                  />
                </Field.Root>
              </>
            ) : (
              <>
                <Field.Root>
                  <Field.Label>Streamable HTTP URL</Field.Label>
                  <Input
                    type="text"
                    value={formState.url}
                    disabled={savingForm}
                    onValueChange={(value) =>
                      setFormState((prev) => (prev ? { ...prev, url: value } : prev))
                    }
                    placeholder="https://mcp.example.com/mcp"
                  />
                </Field.Root>

                <Field.Root>
                  <Field.Label>自定义请求头 headers（可选）</Field.Label>
                  <HeadersEditor
                    rows={formState.headerRows}
                    disabled={savingForm}
                    onChange={(headerRows) =>
                      setFormState((prev) => (prev ? { ...prev, headerRows } : prev))
                    }
                  />
                </Field.Root>

                <details
                  className="ev-tool-disclosure"
                  open={formState.oauthAdvancedOpen}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setFormState((prev) => (prev ? { ...prev, oauthAdvancedOpen: open } : prev));
                  }}
                >
                  <summary>
                    <ChevronRightIcon
                      className="ev-tool-disclosure-chevron"
                      width={14}
                      height={14}
                    />
                    <span>OAuth 客户端参数（可选，动态注册失败时填写）</span>
                  </summary>
                  <div className="ev-tool-disclosure-body">
                    <div className="ev-settings-grid-2">
                      <Field.Root>
                        <Field.Label>clientId</Field.Label>
                        <Input
                          type="text"
                          value={formState.oauthClientId}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) =>
                              prev ? { ...prev, oauthClientId: value } : prev,
                            )
                          }
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>clientSecret</Field.Label>
                        <Input
                          type="password"
                          value={formState.oauthClientSecret}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) =>
                              prev ? { ...prev, oauthClientSecret: value } : prev,
                            )
                          }
                          placeholder="支持 $ENV_VAR"
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>scope</Field.Label>
                        <Input
                          type="text"
                          value={formState.oauthScope}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) => (prev ? { ...prev, oauthScope: value } : prev))
                          }
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>clientRegistration</Field.Label>
                        <select
                          className="ev-select"
                          disabled={savingForm}
                          value={formState.oauthClientRegistration}
                          onChange={(event) => {
                            const v = event.target.value;
                            const reg = v === "auto" || v === "dcr" || v === "cimd" ? v : "";
                            setFormState((prev) =>
                              prev ? { ...prev, oauthClientRegistration: reg } : prev,
                            );
                          }}
                        >
                          <option value="">默认 (auto)</option>
                          <option value="auto">auto</option>
                          <option value="dcr">dcr</option>
                          <option value="cimd">cimd</option>
                        </select>
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>callbackPort</Field.Label>
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={formState.oauthCallbackPort}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) =>
                              prev ? { ...prev, oauthCallbackPort: value } : prev,
                            )
                          }
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>callbackUrl</Field.Label>
                        <Input
                          type="text"
                          value={formState.oauthCallbackUrl}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) =>
                              prev ? { ...prev, oauthCallbackUrl: value } : prev,
                            )
                          }
                          placeholder="http://127.0.0.1:8080/callback"
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>clientName</Field.Label>
                        <Input
                          type="text"
                          value={formState.oauthClientName}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) =>
                              prev ? { ...prev, oauthClientName: value } : prev,
                            )
                          }
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>authServerMetadataUrl</Field.Label>
                        <Input
                          type="text"
                          value={formState.oauthAuthServerMetadataUrl}
                          disabled={savingForm}
                          onValueChange={(value) =>
                            setFormState((prev) =>
                              prev ? { ...prev, oauthAuthServerMetadataUrl: value } : prev,
                            )
                          }
                        />
                      </Field.Root>
                    </div>
                  </div>
                </details>
              </>
            )}

            <div className="ev-inline-actions">
              <Button type="submit" hierarchy="primary" density="compact" pending={savingForm}>
                保存并应用
              </Button>
              <Button
                type="button"
                hierarchy="secondary"
                density="compact"
                onClick={() => setFormState(undefined)}
              >
                取消
              </Button>
            </div>
          </form>
        </div>
      )}

      {loading && statuses.length === 0 ? (
        <div className="ev-settings-card" style={{ alignItems: "center", padding: "24px 16px" }}>
          <Text style={{ color: "var(--ev-fg-subtle)", margin: 0 }}>正在加载 MCP 服务…</Text>
        </div>
      ) : statuses.length === 0 ? (
        <div className="ev-settings-card" style={{ alignItems: "center", padding: "24px 16px" }}>
          <Text style={{ color: "var(--ev-fg-subtle)", margin: 0 }}>
            {projectId ? "当前项目未配置或继承任何 MCP 服务" : "未配置 MCP 服务"}
          </Text>
        </div>
      ) : (
        <div className="ev-settings-list">
          {statuses.map((srv) => {
            const meta = statusMeta(srv.status);
            const scope = scopeBadge(srv.scope);
            const isBusy = Boolean(mutatingServers[srv.name]);
            const effectiveCfg = effectiveServers[srv.name] ?? globalServers[srv.name];
            const ownCfg = projectId
              ? (projectServers[srv.name] ?? effectiveServers[srv.name])
              : globalServers[srv.name];
            const explicitTools = getExplicitToolExposure(ownCfg);
            const globalToolExposure = projectId
              ? getExplicitToolExposure(globalServers[srv.name])
              : {};
            const transport =
              srv.transport ?? (typeof effectiveCfg?.url === "string" ? "http" : "stdio");
            const exposure = srv.exposure ?? DEFAULT_EXPOSURE;
            const roleRouter = srv.roles?.router !== false;
            const roleWorker = srv.roles?.worker !== false;
            const toolsList = srv.tools ?? [];
            const toolsExpanded = Boolean(openTools[srv.name]);
            const logsExpanded = Boolean(openLogs[srv.name]);
            const logState = logsByServer[srv.name];
            const canOAuth = transport === "http" && (!projectId || srv.scope !== "project");
            const needsAuth = srv.status === "auth_required" || srv.authRequired === true;
            const activeOAuth = oauthSession?.serverName === srv.name ? oauthSession : undefined;
            const previewTarget = targetSummary(effectiveCfg);

            return (
              <div key={srv.name} className="ev-settings-row">
                <div className="ev-mcp-row-header">
                  <div className="ev-mcp-row-title-col">
                    <div className="ev-mcp-badges">
                      <span className="ev-dot" data-stage={meta.stage} />
                      <strong className="ev-mono">{srv.name}</strong>
                      <span className="eevee-badge" data-tone={meta.tone}>
                        {meta.label}
                      </span>
                      {projectId && scope && (
                        <span className="eevee-badge" data-tone={scope.tone}>
                          {scope.label}
                        </span>
                      )}
                      <span className="eevee-badge">{transport}</span>
                      <span className="eevee-badge">{exposure}</span>
                      <span className="eevee-badge ev-num">{srv.toolCount} tools</span>
                      {srv.hasResources && (
                        <span className="eevee-badge" data-tone="info">
                          Resources
                        </span>
                      )}
                    </div>
                    {(srv.description || previewTarget) && (
                      <div className="ev-mcp-row-sub">
                        {srv.description && <span>{srv.description}</span>}
                        {srv.description && previewTarget && <span>·</span>}
                        {previewTarget && (
                          <span className="ev-mono ev-truncate" title={previewTarget}>
                            {previewTarget}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="ev-mcp-row-controls">
                    <div className="ev-mcp-roles-inline" title="控制该 MCP 服务对哪些角色可见">
                      <div className="ev-mcp-role-check">
                        <Checkbox.Root
                          id={`${idPrefix}-srv-${srv.name}-router`}
                          checked={roleRouter}
                          disabled={isBusy}
                          onCheckedChange={(checked) =>
                            handleToggleRole(srv, "router", checked === true)
                          }
                        >
                          <Checkbox.Indicator />
                        </Checkbox.Root>
                        <label htmlFor={`${idPrefix}-srv-${srv.name}-router`}>Router</label>
                      </div>
                      <div className="ev-mcp-role-check">
                        <Checkbox.Root
                          id={`${idPrefix}-srv-${srv.name}-worker`}
                          checked={roleWorker}
                          disabled={isBusy}
                          onCheckedChange={(checked) =>
                            handleToggleRole(srv, "worker", checked === true)
                          }
                        >
                          <Checkbox.Indicator />
                        </Checkbox.Root>
                        <label htmlFor={`${idPrefix}-srv-${srv.name}-worker`}>Worker</label>
                      </div>
                    </div>

                    <div className="ev-mcp-enable-switch" title={srv.enabled ? "已启用" : "已禁用"}>
                      <Switch.Root
                        checked={srv.enabled}
                        disabled={isBusy}
                        aria-label={`${srv.enabled ? "禁用" : "启用"} ${srv.name}`}
                        onCheckedChange={(checked) => handleToggleEnabled(srv, checked)}
                      >
                        <Switch.Thumb />
                      </Switch.Root>
                    </div>
                  </div>
                </div>

                <div className="ev-mcp-row-actions">
                  {canOAuth && (
                    <>
                      <Button
                        type="button"
                        hierarchy={needsAuth ? "primary" : "secondary"}
                        density="compact"
                        iconStart={<KeyIcon width={14} height={14} />}
                        disabled={!srv.enabled || isBusy}
                        onClick={() => void startOAuth(srv.name)}
                      >
                        OAuth 登录
                      </Button>
                      <Button
                        type="button"
                        hierarchy="tertiary"
                        density="compact"
                        iconStart={<LogoutIcon width={14} height={14} />}
                        disabled={isBusy}
                        onClick={() => void logoutOAuth(srv.name)}
                      >
                        清除 OAuth
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    iconStart={<RefreshIcon width={14} height={14} />}
                    disabled={!srv.enabled || isBusy}
                    pending={reconnectingServer === srv.name}
                    onClick={() => void reconnect(srv.name)}
                  >
                    重连
                  </Button>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    iconStart={<EditIcon width={14} height={14} />}
                    disabled={isBusy}
                    onClick={() => openEditForm(srv)}
                  >
                    编辑
                  </Button>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    aria-expanded={toolsExpanded}
                    onClick={() =>
                      setOpenTools((prev) => ({ ...prev, [srv.name]: !toolsExpanded }))
                    }
                  >
                    工具 ({toolsList.length})
                  </Button>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    iconStart={<TerminalIcon width={14} height={14} />}
                    aria-expanded={logsExpanded}
                    onClick={() => toggleLogs(srv)}
                  >
                    查看日志
                  </Button>
                  {(!projectId || srv.scope === "project" || srv.scope === "override") && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      iconStart={
                        projectId && srv.scope === "override" ? (
                          <UndoIcon width={14} height={14} />
                        ) : (
                          <DeleteIcon width={14} height={14} />
                        )
                      }
                      disabled={isBusy}
                      onClick={() => void removeOrRevert(srv)}
                    >
                      {projectId && srv.scope === "override" ? "恢复全局" : "删除"}
                    </Button>
                  )}
                </div>

                {srv.error && <div className="ev-error-banner">{srv.error}</div>}

                {activeOAuth && (
                  <div className="ev-mcp-oauth-box">
                    <div className="ev-settings-head">
                      <strong>OAuth 授权流程 · {activeOAuth.serverName}</strong>
                      <Button
                        type="button"
                        hierarchy="secondary"
                        density="compact"
                        onClick={() => void cancelOAuth()}
                      >
                        {activeOAuth.done || activeOAuth.error ? "关闭" : "取消"}
                      </Button>
                    </div>
                    {activeOAuth.instructions && (
                      <Text style={{ margin: 0, fontSize: 13 }}>{activeOAuth.instructions}</Text>
                    )}
                    {activeOAuth.authUrl && (
                      <div className="ev-mcp-oauth-url">
                        <Link href={activeOAuth.authUrl} target="_blank" rel="noreferrer noopener">
                          打开授权页面 <OpenInNewIcon width={13} height={13} />
                        </Link>
                        <span className="ev-mono ev-inline-muted ev-truncate">
                          {activeOAuth.authUrl}
                        </span>
                      </div>
                    )}
                    {activeOAuth.progress.length > 0 && (
                      <div className="ev-mcp-oauth-progress">
                        {activeOAuth.progress.map((entry) => (
                          <div key={entry.id} className="ev-inline-muted">
                            {entry.message}
                          </div>
                        ))}
                      </div>
                    )}
                    {activeOAuth.authUrl && !activeOAuth.done && (
                      <div className="ev-mcp-oauth-input-row">
                        <Input
                          type="text"
                          value={activeOAuth.redirectInput}
                          disabled={activeOAuth.submittingInput}
                          placeholder={
                            activeOAuth.redirectHint
                              ? `若未自动回跳，粘贴回调 URL（如 ${activeOAuth.redirectHint}?code=...）`
                              : "若未自动回跳，粘贴完整回调 URL"
                          }
                          onValueChange={(value) =>
                            setOauthSession((prev) =>
                              prev ? { ...prev, redirectInput: value } : prev,
                            )
                          }
                        />
                        <Button
                          type="button"
                          hierarchy="primary"
                          density="compact"
                          disabled={activeOAuth.redirectInput.trim().length === 0}
                          pending={activeOAuth.submittingInput}
                          onClick={() => void submitOAuthRedirect()}
                        >
                          提交回调 URL
                        </Button>
                      </div>
                    )}
                    {activeOAuth.done && (
                      <div>
                        <span className="eevee-badge" data-tone="positive">
                          授权完成，服务状态已刷新
                        </span>
                      </div>
                    )}
                    {activeOAuth.error && (
                      <div className="ev-error-banner">{activeOAuth.error}</div>
                    )}
                  </div>
                )}

                {toolsExpanded && (
                  <div className="ev-mcp-drawer">
                    {srv.instructions && (
                      <div className="ev-mcp-instructions">
                        <strong>Server Instructions</strong>
                        <pre className="ev-pre" style={{ maxHeight: 120 }}>
                          {srv.instructions}
                        </pre>
                      </div>
                    )}
                    {toolsList.length === 0 ? (
                      <Text className="ev-inline-hint">
                        {srv.status === "connected" || srv.status === "degraded"
                          ? "该服务未暴露任何工具。"
                          : "服务未连接，连接后将显示工具列表。"}
                      </Text>
                    ) : (
                      <div className="ev-mcp-tools-table-wrap">
                        <table className="ev-mcp-tools-table">
                          <thead>
                            <tr>
                              <th>工具名称</th>
                              <th>描述</th>
                              <th>生效暴露</th>
                              <th>单工具覆写</th>
                            </tr>
                          </thead>
                          <tbody>
                            {toolsList.map((tool) => {
                              const explicit = explicitTools[tool.name];
                              const globalExplicit = globalToolExposure[tool.name];
                              const defaultLabel =
                                projectId && globalExplicit !== undefined
                                  ? `继承全局 (${globalExplicit})`
                                  : `默认 (${exposure})`;

                              return (
                                <tr key={tool.name}>
                                  <td className="ev-mono">{tool.name}</td>
                                  <td className="ev-mcp-tool-desc">
                                    {tool.description ?? <span className="ev-inline-muted">—</span>}
                                  </td>
                                  <td>
                                    <span className="eevee-badge">{tool.exposure}</span>
                                  </td>
                                  <td>
                                    <select
                                      className="ev-select"
                                      aria-label={`${tool.name} 暴露方式`}
                                      disabled={isBusy}
                                      value={explicit ?? ""}
                                      onChange={(event) =>
                                        void handleToolExposureChange(
                                          srv,
                                          tool.name,
                                          event.target.value,
                                        )
                                      }
                                    >
                                      <option value="">{defaultLabel}</option>
                                      <option value="codemode">codemode</option>
                                      <option value="deferred">deferred</option>
                                      <option value="direct">direct</option>
                                      <option value="hidden">hidden</option>
                                    </select>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {logsExpanded && (
                  <div className="ev-mcp-drawer">
                    <div className="ev-mcp-log-head">
                      <span className="ev-mono ev-inline-muted ev-truncate">
                        {logState?.logPath ?? "MCP 运行日志"}
                      </span>
                      <div className="ev-inline-actions">
                        <Button
                          type="button"
                          hierarchy="secondary"
                          density="compact"
                          iconStart={<RefreshIcon width={14} height={14} />}
                          pending={logState?.loading === true}
                          onClick={() => void fetchLogs(srv.name)}
                        >
                          刷新日志
                        </Button>
                        <Button
                          type="button"
                          hierarchy="tertiary"
                          density="compact"
                          onClick={() => setOpenLogs((prev) => ({ ...prev, [srv.name]: false }))}
                        >
                          收起
                        </Button>
                      </div>
                    </div>
                    {logState?.error && <div className="ev-error-banner">{logState.error}</div>}
                    <pre className="ev-pre" style={{ maxHeight: 220 }}>
                      {logState?.loading && logState.lines.length === 0
                        ? srv.recentLogs && srv.recentLogs.length > 0
                          ? srv.recentLogs.join("\n")
                          : "加载日志中…"
                        : logState && logState.lines.length > 0
                          ? logState.lines.join("\n")
                          : srv.recentLogs && srv.recentLogs.length > 0
                            ? srv.recentLogs.join("\n")
                            : "(暂无日志)"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
