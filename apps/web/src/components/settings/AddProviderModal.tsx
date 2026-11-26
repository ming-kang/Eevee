import {
  AddIcon,
  CloudDownloadIcon,
  KeyIcon,
  SearchIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Switch,
  Text,
} from "@earendil-works/elanor-react";
import type {
  BuiltinProviderCatalogItem,
  ProbedModel,
  ProviderCatalogResponse,
  ProviderDetail,
} from "@eevee/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { formatTokens } from "../../lib/format.ts";
import { type HeaderRow, HeadersEditor, headersToRows, rowsToHeaders } from "./HeadersEditor.tsx";
import { baseUrlPlaceholder, describeConnectionUrl, validateBaseUrl } from "./provider-utils.ts";

type AddMode = "builtin" | "custom";

export function AddProviderModal({
  initialCatalog,
  onClose,
  onConfigured,
  onStartOAuth,
}: {
  readonly initialCatalog?: ProviderCatalogResponse;
  readonly onClose: () => void;
  readonly onConfigured: (providerId: string, detail?: ProviderDetail) => void;
  readonly onStartOAuth: (providerId: string) => void;
}) {
  const [mode, setMode] = useState<AddMode>("builtin");
  const [catalog, setCatalog] = useState<ProviderCatalogResponse | undefined>(initialCatalog);
  const [loadingCatalog, setLoadingCatalog] = useState(initialCatalog === undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [builtinFilter, setBuiltinFilter] = useState("");
  const [selectedBuiltinId, setSelectedBuiltinId] = useState<string | undefined>(undefined);
  const [builtinApiKey, setBuiltinApiKey] = useState("");
  const [revealBuiltinKey, setRevealBuiltinKey] = useState(false);
  const [builtinBaseUrl, setBuiltinBaseUrl] = useState("");
  const [builtinHeaders, setBuiltinHeaders] = useState<HeaderRow[]>([]);
  const [savingBuiltin, setSavingBuiltin] = useState(false);

  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const [customApi, setCustomApi] = useState(
    initialCatalog?.supportedApis.includes("openai-completions")
      ? "openai-completions"
      : (initialCatalog?.supportedApis[0] ?? "openai-completions"),
  );
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [revealCustomKey, setRevealCustomKey] = useState(false);
  const [customAuthHeader, setCustomAuthHeader] = useState(false);
  const [customHeaders, setCustomHeaders] = useState<HeaderRow[]>([]);

  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | undefined>(undefined);
  const [probeCatalogUrl, setProbeCatalogUrl] = useState<string | undefined>(undefined);
  const [probeTruncated, setProbeTruncated] = useState(false);
  const [probedModels, setProbedModels] = useState<ProbedModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<Record<string, boolean>>({});
  const [probeFilter, setProbeFilter] = useState("");
  const [creatingCustom, setCreatingCustom] = useState(false);

  const probeAbortRef = useRef<AbortController | undefined>(undefined);
  const detailAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingCatalog(true);
    api
      .getProviderCatalog(controller.signal)
      .then((res) => {
        setCatalog(res);
        setCustomApi((current) =>
          res.supportedApis.includes(current)
            ? current
            : res.supportedApis.includes("openai-completions")
              ? "openai-completions"
              : (res.supportedApis[0] ?? current),
        );
        setSelectedBuiltinId((current) => current ?? res.providers[0]?.id);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCatalog(false);
      });
    return () => {
      controller.abort();
      probeAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    detailAbortRef.current?.abort();
    const target = catalog?.providers.find((item) => item.id === selectedBuiltinId);
    if (!target?.hasConfigOverride) {
      setBuiltinBaseUrl("");
      setBuiltinHeaders([]);
      return;
    }
    const controller = new AbortController();
    detailAbortRef.current = controller;
    api
      .getProviderDetail(target.id, controller.signal)
      .then((res) => {
        setBuiltinBaseUrl(res.provider.config?.baseUrl ?? "");
        setBuiltinHeaders(headersToRows(res.provider.config?.headers));
      })
      .catch(() => undefined);
  }, [catalog, selectedBuiltinId]);

  const selectBuiltinProvider = (item: BuiltinProviderCatalogItem) => {
    setSelectedBuiltinId(item.id);
    setBuiltinApiKey("");
    setError(undefined);
  };

  const builtinProviders = catalog?.providers ?? [];
  const builtinQuery = builtinFilter.trim().toLowerCase();
  const visibleBuiltins = builtinQuery
    ? builtinProviders.filter((item) =>
        `${item.id} ${item.name} ${item.baseUrl ?? ""} ${item.apis.join(" ")}`
          .toLowerCase()
          .includes(builtinQuery),
      )
    : builtinProviders;
  const selectedBuiltin = builtinProviders.find((item) => item.id === selectedBuiltinId);

  const builtinBaseUrlTrimmed = builtinBaseUrl.trim();
  const builtinBaseUrlError = builtinBaseUrlTrimmed
    ? validateBaseUrl(builtinBaseUrlTrimmed)
    : undefined;
  const builtinPreview = describeConnectionUrl(selectedBuiltin?.apis[0], builtinBaseUrlTrimmed);

  const customBaseUrlTrimmed = customBaseUrl.trim();
  const customBaseUrlError = customBaseUrlTrimmed
    ? validateBaseUrl(customBaseUrlTrimmed)
    : undefined;
  const customPreview = describeConnectionUrl(customApi, customBaseUrlTrimmed);

  const saveBuiltinGatewayOverrides = async (
    providerId: string,
  ): Promise<ProviderDetail | undefined> => {
    const nextHeaders = rowsToHeaders(builtinHeaders, "网关请求头");
    if (builtinBaseUrlTrimmed && builtinBaseUrlError) {
      throw new Error(builtinBaseUrlError);
    }
    if (!builtinBaseUrlTrimmed && !nextHeaders && !selectedBuiltin?.hasConfigOverride) {
      return undefined;
    }
    if (builtinBaseUrlTrimmed || nextHeaders) {
      const response = await api.updateProvider(providerId, {
        ...(builtinBaseUrlTrimmed ? { baseUrl: builtinBaseUrlTrimmed } : {}),
        ...(nextHeaders ? { headers: nextHeaders } : {}),
      });
      return response.provider;
    }
    return undefined;
  };

  const handleSaveBuiltin = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedBuiltin) return;
    setSavingBuiltin(true);
    setError(undefined);
    try {
      const key = builtinApiKey.trim();
      const nextHeaders = rowsToHeaders(builtinHeaders, "网关请求头");
      if (!key && !builtinBaseUrlTrimmed && !nextHeaders) {
        throw new Error("请填写 API Key 或至少一项网关覆盖配置，或直接点击 OAuth 登录");
      }
      let detail = await saveBuiltinGatewayOverrides(selectedBuiltin.id);
      if (key) {
        await api.setProviderApiKey(selectedBuiltin.id, { key });
      }
      if (key || !detail) {
        detail = (await api.getProviderDetail(selectedBuiltin.id)).provider;
      }
      onConfigured(selectedBuiltin.id, detail);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBuiltin(false);
    }
  };

  const handleBuiltinOAuth = async () => {
    if (!selectedBuiltin) return;
    setSavingBuiltin(true);
    setError(undefined);
    try {
      const detail = await saveBuiltinGatewayOverrides(selectedBuiltin.id);
      onConfigured(selectedBuiltin.id, detail);
      onClose();
      onStartOAuth(selectedBuiltin.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSavingBuiltin(false);
    }
  };

  const runProbeDraft = async () => {
    setError(undefined);
    setProbeError(undefined);
    const baseErr = validateBaseUrl(customBaseUrlTrimmed);
    if (baseErr) {
      setProbeError(baseErr);
      return;
    }
    let headers: Record<string, string> | undefined;
    try {
      headers = rowsToHeaders(customHeaders, "自定义请求头");
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
      return;
    }
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    setProbing(true);
    try {
      const trimmedKey = customApiKey.trim();
      const response = await api.probeDraftProvider(
        {
          baseUrl: customBaseUrlTrimmed,
          api: customApi,
          ...(trimmedKey ? { apiKey: trimmedKey } : {}),
          ...(headers ? { headers } : {}),
          ...(customAuthHeader ? { authHeader: true } : {}),
        },
        controller.signal,
      );
      setProbeCatalogUrl(response.catalogUrl);
      setProbeTruncated(response.truncated);
      setProbedModels(response.models);
      setProbeError(response.error);
      const autoCheck = response.models.length <= 20;
      setSelectedModels(Object.fromEntries(response.models.map((model) => [model.id, autoCheck])));
    } catch (err) {
      if (!controller.signal.aborted) {
        setProbeError(err instanceof Error ? err.message : String(err));
        setProbedModels([]);
      }
    } finally {
      if (!controller.signal.aborted) setProbing(false);
    }
  };

  const probeQuery = probeFilter.trim().toLowerCase();
  const visibleProbedModels = probeQuery
    ? probedModels.filter((model) =>
        `${model.id} ${model.name ?? ""}`.toLowerCase().includes(probeQuery),
      )
    : probedModels;
  const checkedModels = probedModels.filter((model) => selectedModels[model.id] === true);

  const toggleAllVisibleProbed = (checked: boolean) => {
    setSelectedModels((prev) => {
      const next = { ...prev };
      for (const model of visibleProbedModels) {
        next[model.id] = checked;
      }
      return next;
    });
  };

  const handleCreateCustom = async (event: FormEvent) => {
    event.preventDefault();
    setCreatingCustom(true);
    setError(undefined);
    try {
      const id = customId.trim();
      if (!id) throw new Error("Provider ID 不能为空");
      const baseErr = validateBaseUrl(customBaseUrlTrimmed);
      if (baseErr) throw new Error(baseErr);
      if (!customApi) throw new Error("请选择协议 API");
      const headers = rowsToHeaders(customHeaders, "自定义请求头");
      const trimmedName = customName.trim();
      const trimmedKey = customApiKey.trim();
      const response = await api.createProvider({
        id,
        ...(trimmedName ? { name: trimmedName } : {}),
        api: customApi,
        baseUrl: customBaseUrlTrimmed,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        ...(customAuthHeader ? { authHeader: true } : {}),
        ...(headers ? { headers } : {}),
        ...(checkedModels.length > 0
          ? {
              models: checkedModels.map((model) => ({
                id: model.id,
                ...(model.name?.trim() ? { name: model.name.trim() } : {}),
                ...(model.contextWindow === undefined
                  ? {}
                  : { contextWindow: model.contextWindow }),
                ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
                ...(model.input === undefined ? {} : { input: [...model.input] }),
                ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
              })),
            }
          : {}),
      });
      onConfigured(response.provider.id, response.provider);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingCustom(false);
    }
  };

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-add-provider-dialog">
            <Modal.Title>添加 Provider</Modal.Title>
            <Modal.Body className="ev-editor-body">
              <div className="ev-form-stack">
                <div className="ev-settings-head">
                  <SegmentedControl.Root
                    density="compact"
                    value={[mode]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next === "builtin" || next === "custom") {
                        setMode(next);
                        setError(undefined);
                      }
                    }}
                  >
                    <SegmentedControl.Item value="builtin">内置 Provider</SegmentedControl.Item>
                    <SegmentedControl.Item value="custom">自定义 Provider</SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>

                {error && <div className="ev-error-banner">{error}</div>}

                {mode === "builtin" ? (
                  <div className="ev-catalog-picker">
                    <div className="ev-catalog-list-pane">
                      <div className="ev-probe-search">
                        <SearchIcon width={14} height={14} />
                        <input
                          className="ev-raw-input"
                          value={builtinFilter}
                          placeholder="搜索内置 Provider…"
                          onChange={(event) => setBuiltinFilter(event.target.value)}
                        />
                      </div>
                      <div className="ev-catalog-list">
                        {loadingCatalog && builtinProviders.length === 0 ? (
                          <Text className="ev-inline-hint">加载目录中…</Text>
                        ) : visibleBuiltins.length === 0 ? (
                          <Text className="ev-inline-hint">无匹配的内置 Provider。</Text>
                        ) : (
                          visibleBuiltins.map((item) => (
                            <button
                              type="button"
                              key={item.id}
                              className="ev-catalog-item"
                              data-active={item.id === selectedBuiltin?.id}
                              onClick={() => selectBuiltinProvider(item)}
                            >
                              <div className="ev-provider-item-head">
                                <span
                                  className="ev-dot"
                                  data-stage={item.configured ? "done" : "idle"}
                                />
                                <strong className="ev-truncate">{item.name}</strong>
                                <span className="ev-mono ev-inline-muted">{item.id}</span>
                              </div>
                              <div className="ev-provider-item-badges">
                                <span className="ev-inline-muted ev-num">
                                  {item.modelCount} 模型
                                </span>
                                {item.configured && (
                                  <span className="eevee-badge" data-tone="positive">
                                    已配置
                                  </span>
                                )}
                                {item.hasConfigOverride && (
                                  <span className="eevee-badge" data-tone="warning">
                                    已覆盖
                                  </span>
                                )}
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="ev-catalog-config">
                      {selectedBuiltin ? (
                        <form
                          id="ev-add-builtin-form"
                          onSubmit={(event) => void handleSaveBuiltin(event)}
                          className="ev-form-stack"
                        >
                          <div className="ev-editor-section">
                            <div className="ev-provider-item-head">
                              <strong style={{ fontSize: 15 }}>{selectedBuiltin.name}</strong>
                              <span className="ev-mono ev-inline-muted">{selectedBuiltin.id}</span>
                            </div>
                            {selectedBuiltin.baseUrl && (
                              <Text className="ev-inline-hint">
                                默认端点：<span className="ev-mono">{selectedBuiltin.baseUrl}</span>
                              </Text>
                            )}
                            {selectedBuiltin.apis.length > 0 && (
                              <Text className="ev-inline-hint">
                                协议：
                                <span className="ev-mono">{selectedBuiltin.apis.join(", ")}</span>
                              </Text>
                            )}
                          </div>

                          <div className="ev-editor-section">
                            <div className="ev-editor-section-title">身份验证</div>
                            {selectedBuiltin.authMethods.apiKey && (
                              <Field.Root>
                                <Field.Label>API Key</Field.Label>
                                <div className="ev-key-input-row">
                                  <Input
                                    type={revealBuiltinKey ? "text" : "password"}
                                    value={builtinApiKey}
                                    onValueChange={setBuiltinApiKey}
                                    placeholder="输入 API Key（或 $ENV_VAR / !cmd）"
                                  />
                                  <Button
                                    type="button"
                                    hierarchy="secondary"
                                    density="compact"
                                    onClick={() => setRevealBuiltinKey((prev) => !prev)}
                                  >
                                    {revealBuiltinKey ? "隐藏" : "显示"}
                                  </Button>
                                </div>
                              </Field.Root>
                            )}
                            {selectedBuiltin.authMethods.oauth && (
                              <div className="ev-inline-actions">
                                <Button
                                  type="button"
                                  hierarchy="secondary"
                                  density="compact"
                                  iconStart={<KeyIcon width={14} height={14} />}
                                  pending={savingBuiltin}
                                  onClick={() => void handleBuiltinOAuth()}
                                >
                                  {selectedBuiltin.authMethods.oauthLabel ?? "开始 OAuth 登录"}
                                </Button>
                              </div>
                            )}
                          </div>

                          <div className="ev-editor-section">
                            <div className="ev-editor-section-title">网关覆盖（可选）</div>
                            <Field.Root>
                              <Field.Label>自定义 Base URL</Field.Label>
                              <Input
                                type="url"
                                value={builtinBaseUrl}
                                onValueChange={setBuiltinBaseUrl}
                                placeholder={
                                  selectedBuiltin.baseUrl ??
                                  baseUrlPlaceholder(selectedBuiltin.apis[0])
                                }
                              />
                              {builtinBaseUrlError && (
                                <Text className="ev-inline-error">{builtinBaseUrlError}</Text>
                              )}
                              {builtinPreview && (
                                <div
                                  className="ev-connection-note"
                                  data-warning={builtinPreview.warning === true}
                                >
                                  请求 URL 预览：
                                  <span className="ev-mono">{builtinPreview.text}</span>
                                  {builtinPreview.warning && (
                                    <strong> 检测到可能的 /v1 重复</strong>
                                  )}
                                </div>
                              )}
                            </Field.Root>
                            <Field.Root>
                              <Field.Label>自定义请求头（KEY=VALUE）</Field.Label>
                              <HeadersEditor rows={builtinHeaders} onChange={setBuiltinHeaders} />
                            </Field.Root>
                          </div>
                        </form>
                      ) : (
                        <Text className="ev-inline-hint">从左侧选择一个内置 Provider。</Text>
                      )}
                    </div>
                  </div>
                ) : (
                  <form
                    id="ev-add-custom-form"
                    onSubmit={(event) => void handleCreateCustom(event)}
                    className="ev-form-stack"
                  >
                    <section className="ev-editor-section">
                      <div className="ev-editor-section-title">基础与连接</div>
                      <div className="ev-model-form-grid">
                        <Field.Root>
                          <Field.Label>Provider ID</Field.Label>
                          <Input
                            type="text"
                            value={customId}
                            onValueChange={setCustomId}
                            placeholder="my-openai-proxy"
                          />
                        </Field.Root>
                        <Field.Root>
                          <Field.Label>显示名称（可选）</Field.Label>
                          <Input
                            type="text"
                            value={customName}
                            onValueChange={setCustomName}
                            placeholder="留空则使用 Provider ID"
                          />
                        </Field.Root>
                        <Field.Root>
                          <Field.Label>协议 API</Field.Label>
                          <select
                            className="ev-select"
                            value={customApi}
                            onChange={(event) => setCustomApi(event.target.value)}
                          >
                            {(catalog?.supportedApis ?? [customApi]).map((item) => (
                              <option key={item} value={item}>
                                {item}
                              </option>
                            ))}
                          </select>
                        </Field.Root>
                        <Field.Root>
                          <Field.Label>Base URL</Field.Label>
                          <Input
                            type="url"
                            value={customBaseUrl}
                            onValueChange={setCustomBaseUrl}
                            placeholder={baseUrlPlaceholder(customApi)}
                          />
                        </Field.Root>
                      </div>
                      {customBaseUrlError && (
                        <Text className="ev-inline-error">{customBaseUrlError}</Text>
                      )}
                      {customPreview && (
                        <div
                          className="ev-connection-note"
                          data-warning={customPreview.warning === true}
                        >
                          有效请求 URL 预览：<span className="ev-mono">{customPreview.text}</span>
                          {customPreview.warning && (
                            <strong> 检测到可能的 /v1 重复，请检查 Base URL</strong>
                          )}
                        </div>
                      )}
                    </section>

                    <section className="ev-editor-section">
                      <div className="ev-editor-section-title">鉴权与请求头</div>
                      <Field.Root>
                        <Field.Label>API Key（支持明文、$ENV_VAR 或 !cmd）</Field.Label>
                        <div className="ev-key-input-row">
                          <Input
                            type={revealCustomKey ? "text" : "password"}
                            value={customApiKey}
                            onValueChange={setCustomApiKey}
                            placeholder="sk-... 或 $MY_API_KEY 或 !op read ..."
                          />
                          <Button
                            type="button"
                            hierarchy="secondary"
                            density="compact"
                            onClick={() => setRevealCustomKey((prev) => !prev)}
                          >
                            {revealCustomKey ? "隐藏" : "显示"}
                          </Button>
                        </div>
                      </Field.Root>
                      <div className="ev-toggle-field">
                        <span>通过 Authorization: Bearer 请求头传递 API Key（authHeader）</span>
                        <Switch.Root
                          checked={customAuthHeader}
                          onCheckedChange={setCustomAuthHeader}
                        >
                          <Switch.Thumb />
                        </Switch.Root>
                      </div>
                      <Field.Root>
                        <Field.Label>自定义请求头（KEY=VALUE）</Field.Label>
                        <HeadersEditor rows={customHeaders} onChange={setCustomHeaders} />
                      </Field.Root>
                    </section>

                    <section className="ev-editor-section">
                      <div className="ev-editor-section-head">
                        <div className="ev-editor-section-title">探测模型（可选，一步导入）</div>
                        <Button
                          type="button"
                          hierarchy="secondary"
                          density="compact"
                          iconStart={<CloudDownloadIcon width={14} height={14} />}
                          pending={probing}
                          onClick={() => void runProbeDraft()}
                        >
                          探测模型
                        </Button>
                      </div>
                      {probeCatalogUrl && (
                        <Text className="ev-inline-hint">
                          模型目录：<span className="ev-mono">{probeCatalogUrl}</span>
                        </Text>
                      )}
                      {probeError && <div className="ev-error-banner">{probeError}</div>}
                      {probeTruncated && (
                        <div>
                          <span className="eevee-badge" data-tone="warning">
                            探测结果已截断，建议先筛选再勾选
                          </span>
                        </div>
                      )}
                      {probedModels.length > 0 && (
                        <div className="ev-probe-section">
                          <div className="ev-probe-toolbar">
                            <div className="ev-probe-search">
                              <SearchIcon width={14} height={14} />
                              <input
                                className="ev-raw-input"
                                value={probeFilter}
                                placeholder="筛选探测到的模型…"
                                onChange={(event) => setProbeFilter(event.target.value)}
                              />
                            </div>
                            <Button
                              type="button"
                              hierarchy="secondary"
                              density="compact"
                              onClick={() => toggleAllVisibleProbed(true)}
                            >
                              全选可见
                            </Button>
                            <Button
                              type="button"
                              hierarchy="secondary"
                              density="compact"
                              onClick={() => toggleAllVisibleProbed(false)}
                            >
                              全不选
                            </Button>
                          </div>
                          <div className="ev-probe-list">
                            {visibleProbedModels.map((model) => {
                              const checked = selectedModels[model.id] === true;
                              return (
                                <label
                                  key={model.id}
                                  className="ev-probe-row"
                                  data-active={checked}
                                >
                                  <input
                                    type="checkbox"
                                    className="ev-native-checkbox"
                                    checked={checked}
                                    onChange={(event) =>
                                      setSelectedModels((prev) => ({
                                        ...prev,
                                        [model.id]: event.target.checked,
                                      }))
                                    }
                                  />
                                  <span className="ev-mono ev-truncate">{model.id}</span>
                                  {model.name && model.name !== model.id && (
                                    <span className="ev-inline-muted ev-truncate">
                                      {model.name}
                                    </span>
                                  )}
                                  <span className="ev-probe-row-meta ev-num">
                                    {model.contextWindow !== undefined &&
                                      formatTokens(model.contextWindow)}
                                    {model.reasoning === true && " · reasoning"}
                                    {model.input?.includes("image") === true && " · image"}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </section>
                  </form>
                )}
              </div>
            </Modal.Body>
            <Modal.Actions className="ev-editor-actions">
              <Modal.Close
                render={
                  <Button type="button" hierarchy="secondary">
                    取消
                  </Button>
                }
              />
              {mode === "builtin" ? (
                <Button
                  type="submit"
                  form="ev-add-builtin-form"
                  hierarchy="primary"
                  disabled={!selectedBuiltin}
                  pending={savingBuiltin}
                >
                  保存配置
                </Button>
              ) : (
                <Button
                  type="submit"
                  form="ev-add-custom-form"
                  hierarchy="primary"
                  iconStart={<AddIcon width={15} height={15} />}
                  pending={creatingCustom}
                >
                  {checkedModels.length > 0
                    ? `创建并导入 ${checkedModels.length} 个模型`
                    : "创建 Provider"}
                </Button>
              )}
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
