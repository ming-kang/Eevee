import { AddIcon } from "@earendil-works/elanor-icons-react";
import { Button, Modal, SegmentedControl } from "@earendil-works/elanor-react";
import type { ProviderCatalogResponse, ProviderDetail } from "@eevee/protocol";
import { type FormEvent, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { headersToRows } from "./header-rows.ts";
import { AddBuiltinProviderForm } from "./providers/AddBuiltinProviderForm.tsx";
import { AddCustomProviderForm } from "./providers/AddCustomProviderForm.tsx";
import {
  addProviderReducer,
  buildBuiltinOverrideRequest,
  buildCustomProviderRequest,
  buildDraftProbeRequest,
  createAddProviderState,
} from "./providers/add-provider-state.ts";

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
  const [catalog, setCatalog] = useState<ProviderCatalogResponse | undefined>(initialCatalog);
  const [loadingCatalog, setLoadingCatalog] = useState(initialCatalog === undefined);
  const [state, dispatch] = useReducer(addProviderReducer, initialCatalog, createAddProviderState);

  const probeAbortRef = useRef<AbortController | undefined>(undefined);
  const detailAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingCatalog(true);
    api
      .getProviderCatalog(controller.signal)
      .then((res) => {
        setCatalog(res);
        dispatch({ type: "syncCatalog", catalog: res });
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          dispatch({
            type: "setError",
            error: err instanceof Error ? err.message : String(err),
          });
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

  const selectedBuiltinId = state.builtin.selectedId;

  useEffect(() => {
    detailAbortRef.current?.abort();
    const target = catalog?.providers.find((item) => item.id === selectedBuiltinId);
    if (!target?.hasConfigOverride) {
      dispatch({ type: "patchBuiltin", patch: { baseUrl: "", headers: [] } });
      return;
    }
    const controller = new AbortController();
    detailAbortRef.current = controller;
    api
      .getProviderDetail(target.id, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: "patchBuiltin",
          patch: {
            baseUrl: res.provider.config?.baseUrl ?? "",
            headers: headersToRows(res.provider.config?.headers),
          },
        });
      })
      .catch(() => undefined);
  }, [catalog, selectedBuiltinId]);

  const builtinProviders = catalog?.providers ?? [];
  const selectedBuiltin = builtinProviders.find((item) => item.id === selectedBuiltinId);
  const checkedModels = state.probe.models.filter(
    (model) => state.probe.selected[model.id] === true,
  );

  const saveBuiltinGatewayOverrides = async (
    providerId: string,
  ): Promise<ProviderDetail | undefined> => {
    const patch = buildBuiltinOverrideRequest(state.builtin);
    if (!patch) return undefined;
    const response = await api.updateProvider(providerId, patch);
    return response.provider;
  };

  const handleSaveBuiltin = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedBuiltin) return;
    dispatch({ type: "setSaving", saving: true });
    dispatch({ type: "setError", error: undefined });
    try {
      const key = state.builtin.apiKey.trim();
      const overridePatch = buildBuiltinOverrideRequest(state.builtin);
      if (!key && !overridePatch) {
        throw new Error("请填写 API Key 或至少一项网关覆盖配置，或直接点击 OAuth 登录");
      }
      let detail = overridePatch
        ? (await api.updateProvider(selectedBuiltin.id, overridePatch)).provider
        : undefined;
      if (key) {
        await api.setProviderApiKey(selectedBuiltin.id, { key });
      }
      if (key || !detail) {
        detail = (await api.getProviderDetail(selectedBuiltin.id)).provider;
      }
      onConfigured(selectedBuiltin.id, detail);
      onClose();
    } catch (err) {
      dispatch({
        type: "setError",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      dispatch({ type: "setSaving", saving: false });
    }
  };

  const handleBuiltinOAuth = async () => {
    if (!selectedBuiltin) return;
    dispatch({ type: "setSaving", saving: true });
    dispatch({ type: "setError", error: undefined });
    try {
      const detail = await saveBuiltinGatewayOverrides(selectedBuiltin.id);
      onConfigured(selectedBuiltin.id, detail);
      onClose();
      onStartOAuth(selectedBuiltin.id);
    } catch (err) {
      dispatch({
        type: "setError",
        error: err instanceof Error ? err.message : String(err),
      });
      dispatch({ type: "setSaving", saving: false });
    }
  };

  const runProbeDraft = async () => {
    let request: ReturnType<typeof buildDraftProbeRequest>;
    try {
      request = buildDraftProbeRequest(state.custom);
    } catch (err) {
      dispatch({ type: "setError", error: undefined });
      dispatch({
        type: "patchProbe",
        patch: { error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    dispatch({ type: "startProbe" });
    try {
      const response = await api.probeDraftProvider(request, controller.signal);
      if (controller.signal.aborted) return;
      dispatch({
        type: "finishProbe",
        catalogUrl: response.catalogUrl,
        truncated: response.truncated,
        models: response.models,
        error: response.error,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        dispatch({
          type: "failProbe",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const handleCreateCustom = async (event: FormEvent) => {
    event.preventDefault();
    dispatch({ type: "setSaving", saving: true });
    dispatch({ type: "setError", error: undefined });
    try {
      const request = buildCustomProviderRequest(state.custom, checkedModels);
      const response = await api.createProvider(request);
      onConfigured(response.provider.id, response.provider);
      onClose();
    } catch (err) {
      dispatch({
        type: "setError",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      dispatch({ type: "setSaving", saving: false });
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
                    value={[state.mode]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next === "builtin" || next === "custom") {
                        dispatch({ type: "setMode", mode: next });
                      }
                    }}
                  >
                    <SegmentedControl.Item value="builtin">内置 Provider</SegmentedControl.Item>
                    <SegmentedControl.Item value="custom">自定义 Provider</SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>

                {state.error && <div className="ev-error-banner">{state.error}</div>}

                {state.mode === "builtin" ? (
                  <AddBuiltinProviderForm
                    builtinProviders={builtinProviders}
                    selectedBuiltin={selectedBuiltin}
                    loadingCatalog={loadingCatalog}
                    saving={state.saving}
                    draft={state.builtin}
                    dispatch={dispatch}
                    onSubmit={(event) => void handleSaveBuiltin(event)}
                    onOAuth={() => void handleBuiltinOAuth()}
                  />
                ) : (
                  <AddCustomProviderForm
                    supportedApis={catalog?.supportedApis ?? []}
                    draft={state.custom}
                    probe={state.probe}
                    dispatch={dispatch}
                    onSubmit={(event) => void handleCreateCustom(event)}
                    onProbe={() => void runProbeDraft()}
                  />
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
              {state.mode === "builtin" ? (
                <Button
                  type="submit"
                  form="ev-add-builtin-form"
                  hierarchy="primary"
                  disabled={!selectedBuiltin}
                  pending={state.saving}
                >
                  保存配置
                </Button>
              ) : (
                <Button
                  type="submit"
                  form="ev-add-custom-form"
                  hierarchy="primary"
                  iconStart={<AddIcon width={15} height={15} />}
                  pending={state.saving}
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
