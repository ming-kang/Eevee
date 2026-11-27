import { AddIcon, RefreshIcon, SyncIcon, WarningIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, Text } from "@earendil-works/elanor-react";
import type {
  ModelsConfigDiagnostic,
  ProviderCatalogResponse,
  ProviderDetail,
  ProviderSummary,
} from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";
import { AddProviderModal } from "./AddProviderModal.tsx";
import { ModelEditorModal, type ModelEditorTarget } from "./ModelEditorModal.tsx";
import { ProbeModelsModal } from "./ProbeModelsModal.tsx";
import { ProviderAuthCard, ProviderOAuthPanel } from "./providers/ProviderAuthCard.tsx";
import { ProviderConfigForm } from "./providers/ProviderConfigForm.tsx";
import { ProviderModelsList } from "./providers/ProviderModelsList.tsx";
import {
  type ProviderCategoryFilter,
  ProviderSidebarList,
} from "./providers/ProviderSidebarList.tsx";
import { useProviderOAuth } from "./providers/useProviderOAuth.ts";

export function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<ModelsConfigDiagnostic[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [providerFilter, setProviderFilter] = useState("");
  const [category, setCategory] = useState<ProviderCategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = selectedId;

  const [detail, setDetail] = useState<ProviderDetail | undefined>(undefined);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>(undefined);
  const detailAbortRef = useRef<AbortController | undefined>(undefined);

  const [addOpen, setAddOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<ModelEditorTarget | undefined>(undefined);
  const [probeProviderId, setProbeProviderId] = useState<string | undefined>(undefined);

  const loadDetail = useCallback(async (providerId: string) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setLoadingDetail(true);
    setDetailError(undefined);
    try {
      const res = await api.getProviderDetail(providerId, controller.signal);
      setDetail(res.provider);
    } catch (err) {
      if (!controller.signal.aborted) {
        setDetailError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }, []);

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
    return () => {
      detailAbortRef.current?.abort();
    };
  }, [refreshAll]);

  const oauth = useProviderOAuth({
    onComplete: refreshAll,
    onError: setError,
    onSelectProvider: setSelectedId,
  });

  const handleSelectProvider = (providerId: string) => {
    if (providerId === selectedId) return;
    setSelectedId(providerId);
    void loadDetail(providerId);
  };

  const applyDetailChanged = async (next: ProviderDetail) => {
    setDetail(next);
    setSelectedId(next.id);
    try {
      const [providersRes, catalogRes] = await Promise.all([
        api.listProviders(),
        api.getProviderCatalog(),
      ]);
      setProviders(providersRes.providers);
      setDiagnostics(providersRes.diagnostics ?? []);
      setCatalog(catalogRes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(`刷新 Provider 列表失败：${message}`, "danger");
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

      <ProviderOAuthPanel oauth={oauth} />

      <div className="ev-provider-workspace">
        <ProviderSidebarList
          providers={providers}
          filter={providerFilter}
          onFilterChange={setProviderFilter}
          category={category}
          onCategoryChange={setCategory}
          selectedId={selectedId}
          onSelect={handleSelectProvider}
        />

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

              <ProviderAuthCard
                key={detail.id}
                detail={detail}
                onRefresh={refreshAll}
                onStartOAuth={(providerId) => void oauth.startOAuth(providerId)}
                onError={setError}
                onDetailError={setDetailError}
              />

              <ProviderConfigForm
                key={detail.id}
                detail={detail}
                supportedApis={catalog?.supportedApis ?? []}
                onSaved={applyDetailChanged}
                onDetailError={setDetailError}
              />

              <ProviderModelsList
                key={detail.id}
                detail={detail}
                onOpenProbe={setProbeProviderId}
                onAddModel={setEditorTarget}
                onEditModel={setEditorTarget}
              />
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
            void oauth.startOAuth(providerId);
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
