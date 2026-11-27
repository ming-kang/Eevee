import {
  AddIcon,
  CloudDownloadIcon,
  DeleteIcon,
  EditIcon,
  ExperimentIcon,
  KeyIcon,
  LogoutIcon,
  RefreshIcon,
  SearchIcon,
  SyncIcon,
  UndoIcon,
  WarningIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Heading,
  Input,
  Link,
  SegmentedControl,
  Switch,
  Text,
} from "@earendil-works/elanor-react";
import type {
  LoginAuthEvent,
  LoginPromptEvent,
  ModelsConfigDiagnostic,
  ProviderCatalogResponse,
  ProviderDetail,
  ProviderSummary,
  SmokeTestModelResponse,
  UpsertProviderRequest,
} from "@eevee/protocol";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { formatTime, formatTokens } from "../../lib/format.ts";
import { deepEqualJson } from "../../lib/object.ts";
import { AddProviderModal } from "./AddProviderModal.tsx";
import { type HeaderRow, HeadersEditor, headersToRows, rowsToHeaders } from "./HeadersEditor.tsx";
import { ModelEditorModal, type ModelEditorTarget } from "./ModelEditorModal.tsx";
import { ProbeModelsModal } from "./ProbeModelsModal.tsx";
import { baseUrlPlaceholder, describeConnectionUrl, validateBaseUrl } from "./provider-utils.ts";
import { SmokeTestResult } from "./SmokeTestResult.tsx";

type CategoryFilter = "all" | "configured" | "custom" | "builtin";

type IndexedAuthEvent = {
  readonly id: number;
  readonly event: LoginAuthEvent;
};

let nextAuthEventId = 1;

type ActiveLogin = {
  readonly providerId: string;
  readonly sessionId: string;
  readonly authEvents: readonly IndexedAuthEvent[];
  readonly prompt?: LoginPromptEvent;
  readonly done?: string;
  readonly error?: string;
};

type ModelSmokeState = {
  readonly loading: boolean;
  readonly result?: SmokeTestModelResponse;
  readonly error?: string;
};

function formatAuthMeta(provider: ProviderSummary): string {
  if (!provider.configured) return "未配置";
  const parts: string[] = [];
  parts.push(provider.authSource ?? provider.authType ?? "已配置");
  if (provider.authAccountLabel) parts.push(provider.authAccountLabel);
  if (provider.authPreview) parts.push(provider.authPreview);
  return parts.join(" · ");
}

export function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<ModelsConfigDiagnostic[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [providerFilter, setProviderFilter] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = selectedId;

  const [detail, setDetail] = useState<ProviderDetail | undefined>(undefined);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>(undefined);

  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [login, setLogin] = useState<ActiveLogin | undefined>(undefined);
  const [promptInput, setPromptInput] = useState("");
  const loginAbortRef = useRef<AbortController | undefined>(undefined);

  const [configName, setConfigName] = useState("");
  const [configApi, setConfigApi] = useState("");
  const [configBaseUrl, setConfigBaseUrl] = useState("");
  const [configAuthHeader, setConfigAuthHeader] = useState(false);
  const [configHeaders, setConfigHeaders] = useState<HeaderRow[]>([]);
  const [configApiKey, setConfigApiKey] = useState("");
  const [configApiKeyTouched, setConfigApiKeyTouched] = useState(false);
  const [clearConfigApiKey, setClearConfigApiKey] = useState(false);
  const [revealConfigApiKey, setRevealConfigApiKey] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [deletingProvider, setDeletingProvider] = useState(false);

  const [modelFilter, setModelFilter] = useState("");
  const [modelTests, setModelTests] = useState<Record<string, ModelSmokeState>>({});
  const smokeAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const detailAbortRef = useRef<AbortController | undefined>(undefined);

  const [addOpen, setAddOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<ModelEditorTarget | undefined>(undefined);
  const [probeProviderId, setProbeProviderId] = useState<string | undefined>(undefined);

  const syncConfigForm = useCallback((next: ProviderDetail) => {
    setConfigName(next.config?.name ?? "");
    setConfigApi(next.config?.api ?? "");
    setConfigBaseUrl(next.config?.baseUrl ?? "");
    setConfigAuthHeader(next.config?.authHeader ?? false);
    setConfigHeaders(headersToRows(next.config?.headers));
    setConfigApiKey(next.config?.apiKeyRef ?? "");
    setConfigApiKeyTouched(false);
    setClearConfigApiKey(false);
    setRevealConfigApiKey(false);
    setConfigSaved(false);
  }, []);

  const loadDetail = useCallback(
    async (providerId: string) => {
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      setLoadingDetail(true);
      setDetailError(undefined);
      try {
        const res = await api.getProviderDetail(providerId, controller.signal);
        setDetail(res.provider);
        syncConfigForm(res.provider);
      } catch (err) {
        if (!controller.signal.aborted) {
          setDetailError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!controller.signal.aborted) setLoadingDetail(false);
      }
    },
    [syncConfigForm],
  );

  const refreshAll = useCallback(
    async (preferredId?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const [providersRes, catalogRes] = await Promise.all([
          api.listProviders(),
          api.getProviderCatalog(),
        ]);
        setProviders(providersRes.providers);
        setDiagnostics(providersRes.diagnostics ?? []);
        setCatalog(catalogRes);

        const fallbackId = selectedIdRef.current;
        const targetId =
          preferredId && providersRes.providers.some((item) => item.id === preferredId)
            ? preferredId
            : fallbackId && providersRes.providers.some((item) => item.id === fallbackId)
              ? fallbackId
              : (providersRes.providers.find((item) => item.configured)?.id ??
                providersRes.providers[0]?.id);
        setSelectedId(targetId);
        if (targetId) {
          await loadDetail(targetId);
        } else {
          setDetail(undefined);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [loadDetail],
  );

  useEffect(() => {
    void refreshAll();
    const smokeAborts = smokeAbortsRef.current;
    return () => {
      loginAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      for (const controller of smokeAborts.values()) controller.abort();
      smokeAborts.clear();
    };
  }, [refreshAll]);

  const handleSelectProvider = (providerId: string) => {
    if (providerId === selectedId) return;
    setSelectedId(providerId);
    setApiKeyOpen(false);
    setApiKeyInput("");
    setModelFilter("");
    setModelTests({});
    for (const controller of smokeAbortsRef.current.values()) controller.abort();
    smokeAbortsRef.current.clear();
    void loadDetail(providerId);
  };

  const applyDetailChanged = async (next: ProviderDetail) => {
    setDetail(next);
    syncConfigForm(next);
    setSelectedId(next.id);
    try {
      const [providersRes, catalogRes] = await Promise.all([
        api.listProviders(),
        api.getProviderCatalog(),
      ]);
      setProviders(providersRes.providers);
      setDiagnostics(providersRes.diagnostics ?? []);
      setCatalog(catalogRes);
    } catch {
      return;
    }
  };

  const handleReloadModels = async () => {
    setReloading(true);
    setError(undefined);
    setReloadNotice(undefined);
    try {
      const res = await api.reloadModels();
      setDiagnostics(res.diagnostics);
      setReloadNotice(
        `已重载 models.json（${res.providerCount} Provider / ${res.modelCount} 模型）`,
      );
      await refreshAll(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  };

  const saveApiKey = async (providerId: string) => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setSavingKey(true);
    setError(undefined);
    try {
      await api.setProviderApiKey(providerId, { key: trimmed });
      setApiKeyOpen(false);
      setApiKeyInput("");
      await refreshAll(providerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  const logout = async (providerId: string) => {
    setError(undefined);
    try {
      await api.logoutProvider(providerId);
      await refreshAll(providerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startOAuth = async (providerId: string) => {
    loginAbortRef.current?.abort();
    const controller = new AbortController();
    loginAbortRef.current = controller;
    setError(undefined);
    setSelectedId(providerId);
    try {
      const started = await api.startProviderLogin(
        providerId,
        { type: "oauth" },
        controller.signal,
      );
      setLogin({ providerId, sessionId: started.sessionId, authEvents: [] });
      setPromptInput("");
      for await (const event of api.streamLoginSession(providerId, started.sessionId, {
        signal: controller.signal,
      })) {
        if (event.type === "auth") {
          setLogin((prev) =>
            prev
              ? {
                  ...prev,
                  authEvents: [...prev.authEvents, { id: nextAuthEventId++, event: event.event }],
                }
              : prev,
          );
        } else if (event.type === "prompt") {
          setLogin((prev) => (prev ? { ...prev, prompt: event.prompt } : prev));
          setPromptInput(event.prompt.type === "select" ? (event.prompt.options[0]?.id ?? "") : "");
        } else if (event.type === "complete") {
          setLogin((prev) =>
            prev
              ? { ...prev, prompt: undefined, done: `${event.complete.providerId} 已完成登录` }
              : prev,
          );
          await refreshAll(providerId);
        } else if (event.type === "error") {
          setLogin((prev) =>
            prev ? { ...prev, prompt: undefined, error: event.error.message } : prev,
          );
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const submitPrompt = async () => {
    if (!login?.prompt) return;
    try {
      await api.submitLoginInput(login.providerId, login.sessionId, {
        promptId: login.prompt.promptId,
        value: promptInput,
      });
      setLogin((prev) => (prev ? { ...prev, prompt: undefined } : prev));
      setPromptInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelLogin = async () => {
    if (!login) return;
    loginAbortRef.current?.abort();
    await api.cancelLoginSession(login.providerId, login.sessionId).catch(() => undefined);
    setLogin(undefined);
  };

  const handleSaveConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setSavingConfig(true);
    setDetailError(undefined);
    setConfigSaved(false);
    try {
      const patch: Record<string, unknown> = {};
      const trimmedName = configName.trim();
      if (trimmedName !== (detail.config?.name ?? "")) {
        patch.name = trimmedName ? trimmedName : null;
      }
      const trimmedApi = configApi.trim();
      if (trimmedApi !== (detail.config?.api ?? "")) {
        patch.api = trimmedApi ? trimmedApi : null;
      }
      const trimmedBaseUrl = configBaseUrl.trim();
      if (trimmedBaseUrl) {
        const baseErr = validateBaseUrl(trimmedBaseUrl);
        if (baseErr) throw new Error(baseErr);
      }
      if (trimmedBaseUrl !== (detail.config?.baseUrl ?? "")) {
        patch.baseUrl = trimmedBaseUrl ? trimmedBaseUrl : null;
      }
      if (configAuthHeader !== (detail.config?.authHeader ?? false)) {
        patch.authHeader = configAuthHeader ? true : null;
      }
      const nextHeaders = rowsToHeaders(configHeaders, "Provider 请求头");
      if (!deepEqualJson(nextHeaders, detail.config?.headers)) {
        patch.headers = nextHeaders ?? null;
      }
      if (clearConfigApiKey) {
        patch.apiKey = null;
      } else if (configApiKeyTouched) {
        const trimmedKey = configApiKey.trim();
        if (trimmedKey) patch.apiKey = trimmedKey;
        else if (detail.config?.apiKeyRef !== undefined) patch.apiKey = null;
      }

      if (Object.keys(patch).length > 0) {
        const res = await api.updateProvider(detail.id, patch as UpsertProviderRequest);
        await applyDetailChanged(res.provider);
      }
      setConfigSaved(true);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleDeleteOrRevertProvider = async () => {
    if (!detail) return;
    const isCustom = detail.kind === "custom";
    const confirmText = isCustom
      ? `确定删除自定义 Provider「${detail.id}」及其所有配置与模型？`
      : `确定还原内置 Provider「${detail.id}」的所有 models.json 覆盖与自定义模型？`;
    if (!window.confirm(confirmText)) return;
    setDeletingProvider(true);
    setDetailError(undefined);
    try {
      await api.deleteProvider(detail.id);
      await refreshAll(isCustom ? undefined : detail.id);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingProvider(false);
    }
  };

  const runModelSmokeTest = async (providerId: string, modelId: string) => {
    const key = `${providerId}\0${modelId}`;
    smokeAbortsRef.current.get(key)?.abort();
    const controller = new AbortController();
    smokeAbortsRef.current.set(key, controller);
    setModelTests((prev) => ({ ...prev, [key]: { loading: true } }));
    try {
      const result = await api.testProviderModel(providerId, modelId, {}, controller.signal);
      setModelTests((prev) => ({ ...prev, [key]: { loading: false, result } }));
    } catch (err) {
      if (!controller.signal.aborted) {
        setModelTests((prev) => ({
          ...prev,
          [key]: { loading: false, error: err instanceof Error ? err.message : String(err) },
        }));
      }
    }
  };

  const clearModelSmokeTest = (providerId: string, modelId: string) => {
    const key = `${providerId}\0${modelId}`;
    smokeAbortsRef.current.get(key)?.abort();
    smokeAbortsRef.current.delete(key);
    setModelTests((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const query = providerFilter.trim().toLowerCase();
  const visibleProviders = providers.filter((provider) => {
    if (category === "configured" && !provider.configured) return false;
    if (category === "custom" && provider.kind !== "custom") return false;
    if (category === "builtin" && provider.kind === "custom") return false;
    if (!query) return true;
    return `${provider.id} ${provider.name} ${provider.api ?? ""} ${provider.authAccountLabel ?? ""}`
      .toLowerCase()
      .includes(query);
  });

  const detailModelQuery = modelFilter.trim().toLowerCase();
  const detailModels = detail
    ? detailModelQuery
      ? detail.models.filter((model) =>
          `${model.id} ${model.name} ${model.api}`.toLowerCase().includes(detailModelQuery),
        )
      : detail.models
    : [];

  const supportedApis = catalog?.supportedApis ?? [];
  const apiOptions = Array.from(
    new Set([
      ...supportedApis,
      ...(configApi ? [configApi] : []),
      ...(detail?.api ? [detail.api] : []),
    ]),
  );

  const effectiveConfigApi =
    configApi.trim() || detail?.config?.api || detail?.api || detail?.models[0]?.api;
  const trimmedConfigBaseUrl = configBaseUrl.trim();
  const configBaseUrlError = trimmedConfigBaseUrl
    ? validateBaseUrl(trimmedConfigBaseUrl)
    : undefined;
  const effectiveBaseUrl = trimmedConfigBaseUrl || detail?.baseUrl;
  const liveConnectionNote =
    describeConnectionUrl(effectiveConfigApi, effectiveBaseUrl) ??
    (!trimmedConfigBaseUrl && !configApi.trim() ? detail?.connectionNote : undefined);

  return (
    <div className="ev-settings-section">
      <div className="ev-settings-head">
        <Heading level={2} size={5}>
          Providers
        </Heading>
        <div className="ev-inline-actions">
          <Button
            hierarchy="primary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            onClick={() => setAddOpen(true)}
          >
            添加 Provider
          </Button>
          <Button
            hierarchy="secondary"
            density="compact"
            iconStart={<SyncIcon width={15} height={15} />}
            pending={reloading}
            onClick={() => void handleReloadModels()}
          >
            重载 models.json
          </Button>
          <Button
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={15} height={15} />}
            pending={loading}
            onClick={() => void refreshAll(selectedId)}
          >
            刷新
          </Button>
        </div>
      </div>

      {reloadNotice && (
        <div>
          <span className="eevee-badge" data-tone="positive">
            {reloadNotice}
          </span>
        </div>
      )}

      {error && <div className="ev-error-banner">{error}</div>}

      {diagnostics.length > 0 && (
        <div className="ev-warning-banner" role="alert">
          <div className="ev-warning-banner-head">
            <WarningIcon width={16} height={16} />
            <strong>models.json 配置诊断（{diagnostics.length}）</strong>
          </div>
          <div className="ev-diagnostic-list">
            {diagnostics.map((diag) => (
              <div
                key={`${diag.path}:${diag.line ?? ""}:${diag.column ?? ""}:${diag.message}`}
                className="ev-diagnostic-item"
              >
                <span className="ev-mono">
                  {diag.path}
                  {diag.line !== undefined
                    ? `:${diag.line}${diag.column !== undefined ? `:${diag.column}` : ""}`
                    : ""}
                </span>
                <span>{diag.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {login && (
        <div className="ev-settings-card">
          <div className="ev-settings-head">
            <Heading level={3} size={6}>
              OAuth 登录 · {login.providerId}
            </Heading>
            <Button hierarchy="secondary" density="compact" onClick={() => void cancelLogin()}>
              关闭
            </Button>
          </div>
          {login.authEvents.map(({ id, event: ev }) => (
            <div key={id} style={{ fontSize: "13.5px" }}>
              {ev.type === "auth_url" && (
                <div className="ev-form-stack" style={{ gap: 4 }}>
                  {ev.instructions && <Text style={{ margin: 0 }}>{ev.instructions}</Text>}
                  <Link href={ev.url} target="_blank" rel="noreferrer noopener">
                    {ev.url}
                  </Link>
                </div>
              )}
              {ev.type === "device_code" && (
                <div className="ev-form-stack" style={{ gap: 4 }}>
                  <Text style={{ margin: 0 }}>
                    授权码：<strong className="ev-mono">{ev.userCode}</strong>
                  </Text>
                  <Link href={ev.verificationUri} target="_blank" rel="noreferrer noopener">
                    {ev.verificationUri}
                  </Link>
                </div>
              )}
              {(ev.type === "info" || ev.type === "progress") && (
                <Text style={{ margin: 0 }}>{ev.message}</Text>
              )}
            </div>
          ))}
          {login.prompt && (
            <div className="ev-form-stack" style={{ gap: 8 }}>
              <Text style={{ margin: 0, fontWeight: 500 }}>{login.prompt.message}</Text>
              {login.prompt.type === "select" ? (
                <select
                  className="ev-select"
                  value={promptInput}
                  onChange={(event) => setPromptInput(event.target.value)}
                >
                  {login.prompt.options.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  type={login.prompt.type === "secret" ? "password" : "text"}
                  value={promptInput}
                  onValueChange={(value) => setPromptInput(value)}
                  placeholder={login.prompt.placeholder}
                />
              )}
              <div>
                <Button hierarchy="primary" density="compact" onClick={() => void submitPrompt()}>
                  提交
                </Button>
              </div>
            </div>
          )}
          {login.done && (
            <div>
              <span className="eevee-badge" data-tone="positive">
                {login.done}
              </span>
            </div>
          )}
          {login.error && <div className="ev-error-banner">{login.error}</div>}
        </div>
      )}

      <div className="ev-provider-workspace">
        <div className="ev-provider-list-pane">
          <div className="ev-provider-filter-stack">
            <div className="ev-probe-search">
              <SearchIcon width={14} height={14} />
              <input
                className="ev-raw-input"
                value={providerFilter}
                placeholder="筛选 Provider…"
                onChange={(event) => setProviderFilter(event.target.value)}
              />
            </div>
            <SegmentedControl.Root
              density="compact"
              value={[category]}
              onValueChange={(values) => {
                const next = values[0];
                if (
                  next === "all" ||
                  next === "configured" ||
                  next === "custom" ||
                  next === "builtin"
                ) {
                  setCategory(next);
                }
              }}
            >
              <SegmentedControl.Item value="all">全部</SegmentedControl.Item>
              <SegmentedControl.Item value="configured">已配置</SegmentedControl.Item>
              <SegmentedControl.Item value="custom">自定义</SegmentedControl.Item>
              <SegmentedControl.Item value="builtin">内置</SegmentedControl.Item>
            </SegmentedControl.Root>
          </div>

          <div className="ev-provider-list">
            {visibleProviders.length === 0 ? (
              <Text className="ev-inline-hint" style={{ padding: 12 }}>
                没有匹配的 Provider。
              </Text>
            ) : (
              visibleProviders.map((provider) => {
                const isCustom = provider.kind === "custom";
                return (
                  <button
                    type="button"
                    key={provider.id}
                    className="ev-provider-item"
                    data-active={provider.id === selectedId}
                    onClick={() => handleSelectProvider(provider.id)}
                  >
                    <div className="ev-provider-item-head">
                      <span className="ev-dot" data-stage={provider.configured ? "done" : "idle"} />
                      <strong className="ev-truncate">{provider.name}</strong>
                      <span className="ev-mono ev-inline-muted ev-truncate">{provider.id}</span>
                    </div>
                    <div className="ev-provider-item-badges">
                      <span className="eevee-badge" data-tone={isCustom ? "info" : "neutral"}>
                        {isCustom ? "自定义" : "内置"}
                      </span>
                      {!isCustom && provider.hasConfigOverride && (
                        <span className="eevee-badge" data-tone="warning">
                          已覆盖
                        </span>
                      )}
                      <span className="ev-inline-muted ev-num">{provider.modelCount} 模型</span>
                    </div>
                    <div className="ev-provider-item-meta ev-truncate">
                      {formatAuthMeta(provider)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="ev-provider-detail-pane">
          {!selectedId ? (
            <div className="ev-settings-card">
              <Text className="ev-inline-hint">从左侧选择一个 Provider 查看详情。</Text>
            </div>
          ) : loadingDetail && (!detail || detail.id !== selectedId) ? (
            <div className="ev-settings-card">
              <Text className="ev-inline-hint">加载 Provider 详情…</Text>
            </div>
          ) : detail ? (
            <div className="ev-form-stack">
              {detailError && <div className="ev-error-banner">{detailError}</div>}

              <div className="ev-settings-card">
                <div className="ev-provider-detail-head">
                  <div className="ev-provider-item-head">
                    <span className="ev-dot" data-stage={detail.configured ? "done" : "idle"} />
                    <Heading level={3} size={5}>
                      {detail.name}
                    </Heading>
                    <span className="ev-mono ev-inline-muted">{detail.id}</span>
                    <span
                      className="eevee-badge"
                      data-tone={detail.kind === "custom" ? "info" : "neutral"}
                    >
                      {detail.kind === "custom" ? "自定义" : "内置"}
                    </span>
                    {detail.kind !== "custom" && detail.hasConfigOverride && (
                      <span className="eevee-badge" data-tone="warning">
                        已覆盖
                      </span>
                    )}
                    <span
                      className="eevee-badge"
                      data-tone={detail.configured ? "positive" : "neutral"}
                    >
                      {detail.configured ? "已配置" : "未配置"}
                    </span>
                  </div>
                  <div className="ev-inline-actions">
                    {detail.kind === "custom" && (
                      <Button
                        type="button"
                        hierarchy="tertiary"
                        semantic="negative"
                        density="compact"
                        iconStart={<DeleteIcon width={14} height={14} />}
                        pending={deletingProvider}
                        onClick={() => void handleDeleteOrRevertProvider()}
                      >
                        删除自定义 Provider
                      </Button>
                    )}
                    {detail.kind !== "custom" && detail.hasConfigOverride && (
                      <Button
                        type="button"
                        hierarchy="tertiary"
                        semantic="negative"
                        density="compact"
                        iconStart={<UndoIcon width={14} height={14} />}
                        pending={deletingProvider}
                        onClick={() => void handleDeleteOrRevertProvider()}
                      >
                        还原内置覆盖
                      </Button>
                    )}
                  </div>
                </div>

                <div className="ev-auth-summary">
                  <span>
                    认证状态：<strong>{formatAuthMeta(detail)}</strong>
                  </span>
                  {detail.authExpiresAt !== undefined && (
                    <span className="ev-inline-muted ev-num">
                      过期时间：{formatTime(detail.authExpiresAt)}
                    </span>
                  )}
                </div>

                <div className="ev-inline-actions">
                  {detail.authMethods.apiKey && (
                    <Button
                      type="button"
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<KeyIcon width={14} height={14} />}
                      onClick={() => {
                        setApiKeyOpen((prev) => !prev);
                        setApiKeyInput("");
                      }}
                    >
                      {detail.configured ? "更新 API Key" : "设置 API Key"}
                    </Button>
                  )}
                  {detail.authMethods.oauth && (
                    <Button
                      type="button"
                      hierarchy="secondary"
                      density="compact"
                      onClick={() => void startOAuth(detail.id)}
                    >
                      {detail.authMethods.oauthLabel ?? "OAuth 登录"}
                    </Button>
                  )}
                  {detail.configured && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      iconStart={<LogoutIcon width={14} height={14} />}
                      onClick={() => void logout(detail.id)}
                    >
                      清除凭据
                    </Button>
                  )}
                </div>

                {apiKeyOpen && (
                  <div className="ev-inline-key-form">
                    <Field.Root style={{ flex: 1 }}>
                      <Field.Label>API Key（写入 auth.json）</Field.Label>
                      <Input
                        type="password"
                        value={apiKeyInput}
                        onValueChange={setApiKeyInput}
                        placeholder="输入 API Key（或 $ENV_VAR / !cmd）"
                      />
                    </Field.Root>
                    <Button
                      type="button"
                      hierarchy="primary"
                      density="compact"
                      pending={savingKey}
                      onClick={() => void saveApiKey(detail.id)}
                    >
                      保存
                    </Button>
                  </div>
                )}
              </div>

              <div className="ev-settings-card">
                <div className="ev-settings-head">
                  <Heading level={3} size={6}>
                    连接与覆盖配置（models.json）
                  </Heading>
                  {configSaved && (
                    <span className="eevee-badge" data-tone="positive">
                      已保存
                    </span>
                  )}
                </div>
                <form onSubmit={(event) => void handleSaveConfig(event)} className="ev-form-stack">
                  <div className="ev-model-form-grid">
                    <Field.Root>
                      <Field.Label>显示名称</Field.Label>
                      <Input
                        type="text"
                        value={configName}
                        onValueChange={(value) => {
                          setConfigName(value);
                          setConfigSaved(false);
                        }}
                        placeholder={detail.name}
                      />
                    </Field.Root>
                    <Field.Root>
                      <Field.Label>协议 API</Field.Label>
                      <select
                        className="ev-select"
                        value={configApi}
                        onChange={(event) => {
                          setConfigApi(event.target.value);
                          setConfigSaved(false);
                        }}
                      >
                        <option value="">
                          {detail.kind === "custom" ? "由模型各自指定" : "继承内置默认"}
                        </option>
                        {apiOptions.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </Field.Root>
                  </div>

                  <Field.Root>
                    <Field.Label>Base URL</Field.Label>
                    <Input
                      type="url"
                      value={configBaseUrl}
                      onValueChange={(value) => {
                        setConfigBaseUrl(value);
                        setConfigSaved(false);
                      }}
                      placeholder={detail.baseUrl ?? baseUrlPlaceholder(effectiveConfigApi)}
                    />
                    {configBaseUrlError && (
                      <Text className="ev-inline-error">{configBaseUrlError}</Text>
                    )}
                    {liveConnectionNote && (
                      <div
                        className="ev-connection-note"
                        data-warning={liveConnectionNote.warning === true}
                      >
                        有效请求 URL：<span className="ev-mono">{liveConnectionNote.text}</span>
                        {liveConnectionNote.warning && (
                          <strong> 检测到可能的 /v1 重复，请检查 Base URL</strong>
                        )}
                      </div>
                    )}
                  </Field.Root>

                  <Field.Root>
                    <Field.Label>models.json 中的 apiKey（支持 $ENV_VAR / !cmd）</Field.Label>
                    <div className="ev-key-input-row">
                      <Input
                        type={revealConfigApiKey ? "text" : "password"}
                        value={configApiKey}
                        disabled={clearConfigApiKey}
                        onValueChange={(value) => {
                          setConfigApiKey(value);
                          setConfigApiKeyTouched(true);
                          setClearConfigApiKey(false);
                          setConfigSaved(false);
                        }}
                        placeholder={
                          detail.config?.hasApiKey && !detail.config?.apiKeyRef
                            ? "已设置密钥（留空保持不变，或输入新值覆盖）"
                            : "留空则使用 auth.json 或环境变量"
                        }
                      />
                      <Button
                        type="button"
                        hierarchy="secondary"
                        density="compact"
                        onClick={() => setRevealConfigApiKey((prev) => !prev)}
                      >
                        {revealConfigApiKey ? "隐藏" : "显示"}
                      </Button>
                      {detail.config?.hasApiKey && (
                        <Button
                          type="button"
                          hierarchy={clearConfigApiKey ? "primary" : "secondary"}
                          density="compact"
                          onClick={() => {
                            setClearConfigApiKey((prev) => !prev);
                            setConfigApiKey("");
                            setConfigApiKeyTouched(true);
                            setConfigSaved(false);
                          }}
                        >
                          {clearConfigApiKey ? "已标记清除" : "清除 apiKey"}
                        </Button>
                      )}
                    </div>
                  </Field.Root>

                  <div className="ev-toggle-field">
                    <span>使用 Authorization: Bearer 请求头发送 API Key（authHeader）</span>
                    <Switch.Root
                      checked={configAuthHeader}
                      onCheckedChange={(checked) => {
                        setConfigAuthHeader(checked);
                        setConfigSaved(false);
                      }}
                    >
                      <Switch.Thumb />
                    </Switch.Root>
                  </div>

                  <Field.Root>
                    <Field.Label>自定义请求头（KEY=VALUE）</Field.Label>
                    <HeadersEditor
                      rows={configHeaders}
                      onChange={(rows) => {
                        setConfigHeaders(rows);
                        setConfigSaved(false);
                      }}
                    />
                  </Field.Root>

                  <div className="ev-inline-actions">
                    <Button
                      type="submit"
                      hierarchy="primary"
                      density="compact"
                      pending={savingConfig}
                    >
                      保存 Provider 配置
                    </Button>
                  </div>
                </form>
              </div>

              <div className="ev-settings-card">
                <div className="ev-settings-head">
                  <Heading level={3} size={6}>
                    模型列表
                    <span
                      className="ev-num"
                      style={{
                        marginLeft: 8,
                        fontSize: 12.5,
                        fontWeight: 400,
                        color: "var(--ev-fg-subtle)",
                      }}
                    >
                      {detailModels.length === detail.models.length
                        ? detail.models.length
                        : `${detailModels.length} / ${detail.models.length}`}
                    </span>
                  </Heading>
                  <div className="ev-provider-models-toolbar">
                    <div className="ev-probe-search" style={{ minWidth: 160 }}>
                      <SearchIcon width={14} height={14} />
                      <input
                        className="ev-raw-input"
                        value={modelFilter}
                        placeholder="筛选模型…"
                        onChange={(event) => setModelFilter(event.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<CloudDownloadIcon width={14} height={14} />}
                      onClick={() => setProbeProviderId(detail.id)}
                    >
                      探测并导入模型
                    </Button>
                    <Button
                      type="button"
                      hierarchy="primary"
                      density="compact"
                      iconStart={<AddIcon width={14} height={14} />}
                      onClick={() =>
                        setEditorTarget({
                          providerId: detail.id,
                          providerApi: detail.config?.api ?? detail.api ?? detail.models[0]?.api,
                          providerBaseUrl: detail.baseUrl,
                        })
                      }
                    >
                      新增模型
                    </Button>
                  </div>
                </div>

                {detailModels.length === 0 ? (
                  <Text className="ev-inline-hint">
                    {detail.models.length === 0
                      ? "该 Provider 暂无模型，可点击「探测并导入模型」或「新增模型」。"
                      : "没有匹配的模型。"}
                  </Text>
                ) : (
                  <div className="ev-provider-model-list">
                    {detailModels.map((model) => {
                      const testKey = `${detail.id}\0${model.id}`;
                      const smoke = modelTests[testKey];
                      return (
                        <div key={model.id} className="ev-provider-model-row">
                          <div className="ev-provider-model-top">
                            <div className="ev-provider-model-main">
                              <div className="ev-provider-item-head">
                                <span
                                  className="ev-dot"
                                  data-stage={model.available ? "done" : "idle"}
                                />
                                <strong>{model.name}</strong>
                                <span className="ev-mono ev-inline-muted">{model.id}</span>
                                {model.isCustom && (
                                  <span className="eevee-badge" data-tone="info">
                                    自定义
                                  </span>
                                )}
                                {!model.isCustom && model.hasOverride && (
                                  <span className="eevee-badge" data-tone="warning">
                                    已覆盖
                                  </span>
                                )}
                                {model.reasoning && <span className="eevee-badge">reasoning</span>}
                                {model.input.includes("image") && (
                                  <span className="eevee-badge">image</span>
                                )}
                              </div>
                              <div className="ev-provider-model-meta">
                                <span className="ev-mono">{model.api}</span>
                                <span className="ev-num">
                                  上下文 {formatTokens(model.contextWindow)}
                                </span>
                                <span className="ev-num">
                                  最大输出 {formatTokens(model.maxTokens)}
                                </span>
                                {model.supportedThinkingLevels.length > 0 && (
                                  <span className="ev-thinking-pills">
                                    {model.supportedThinkingLevels.map((level) => (
                                      <span key={level} className="ev-thinking-pill ev-mono">
                                        {level}
                                      </span>
                                    ))}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="ev-provider-model-actions">
                              <Button
                                type="button"
                                hierarchy="secondary"
                                density="compact"
                                iconStart={<ExperimentIcon width={14} height={14} />}
                                pending={smoke?.loading === true}
                                onClick={() => void runModelSmokeTest(detail.id, model.id)}
                              >
                                测试
                              </Button>
                              <Button
                                type="button"
                                hierarchy="secondary"
                                density="compact"
                                iconStart={<EditIcon width={14} height={14} />}
                                onClick={() =>
                                  setEditorTarget({
                                    providerId: detail.id,
                                    providerApi: detail.config?.api ?? detail.api ?? model.api,
                                    providerBaseUrl: detail.baseUrl,
                                    model,
                                  })
                                }
                              >
                                编辑
                              </Button>
                            </div>
                          </div>

                          {smoke && !smoke.loading && (smoke.result || smoke.error) && (
                            <div className="ev-profile-smoke">
                              {smoke.error && <div className="ev-error-banner">{smoke.error}</div>}
                              {smoke.result && <SmokeTestResult result={smoke.result} />}
                              <div>
                                <Button
                                  type="button"
                                  hierarchy="tertiary"
                                  density="compact"
                                  onClick={() => clearModelSmokeTest(detail.id, model.id)}
                                >
                                  收起结果
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            detailError && <div className="ev-error-banner">{detailError}</div>
          )}
        </div>
      </div>

      {addOpen && (
        <AddProviderModal
          initialCatalog={catalog}
          onClose={() => setAddOpen(false)}
          onConfigured={(providerId, nextDetail) => {
            if (
              (nextDetail?.kind === "custom" && category === "builtin") ||
              (nextDetail?.kind !== "custom" && category === "custom")
            ) {
              setCategory("all");
            }
            if (nextDetail) {
              void applyDetailChanged(nextDetail);
            } else {
              void refreshAll(providerId);
            }
          }}
          onStartOAuth={(providerId) => {
            void startOAuth(providerId);
          }}
        />
      )}

      {editorTarget && (
        <ModelEditorModal
          target={editorTarget}
          compatSchemas={catalog?.compatSchemas ?? {}}
          onClose={() => setEditorTarget(undefined)}
          onProviderChanged={(next) => {
            void applyDetailChanged(next);
          }}
        />
      )}

      {probeProviderId && (
        <ProbeModelsModal
          providerId={probeProviderId}
          onClose={() => setProbeProviderId(undefined)}
          onImported={(next) => {
            void applyDetailChanged(next);
          }}
        />
      )}
    </div>
  );
}
