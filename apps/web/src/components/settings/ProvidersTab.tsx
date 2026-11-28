import { AddIcon, RefreshIcon, SyncIcon, WarningIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  PageHeader,
  Section,
  Skeleton,
  SkeletonText,
  Text,
} from "@earendil-works/elanor-react";
import type {
  ModelsConfigDiagnostic,
  ProviderCatalogResponse,
  ProviderDetail,
  ProviderSummary,
} from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.ts";
import { showToast } from "../../lib/toasts.ts";
import { useAbortableAsync } from "../../lib/useAbortableAsync.ts";
import { invalidateEngineModelsCache } from "../../lib/useEngineSettings.ts";
import { AddProviderModal } from "./AddProviderModal.tsx";
import { ModelEditorModal, type ModelEditorTarget } from "./ModelEditorModal.tsx";
import { ProbeModelsModal } from "./ProbeModelsModal.tsx";
import { sortProvidersForSidebar } from "./provider-utils.ts";
import { ProviderAuthCard, ProviderOAuthPanel } from "./providers/ProviderAuthCard.tsx";
import { ProviderConfigForm } from "./providers/ProviderConfigForm.tsx";
import { ProviderModelsList } from "./providers/ProviderModelsList.tsx";
import {
  type ProviderCategoryFilter,
  ProviderSidebarList,
} from "./providers/ProviderSidebarList.tsx";
import { useProviderOAuth } from "./providers/useProviderOAuth.ts";

export function ProvidersTab() {
  const { t } = useI18n();
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
  const { run: runLoadDetail, abort: abortLoadDetail } = useAbortableAsync();
  const { run: runRefreshAll } = useAbortableAsync();

  const [addOpen, setAddOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<ModelEditorTarget | undefined>(undefined);
  const [probeProviderId, setProbeProviderId] = useState<string | undefined>(undefined);

  const loadDetail = useCallback(
    async (providerId: string) => {
      setLoadingDetail(true);
      setDetailError(undefined);
      try {
        const res = await runLoadDetail((signal) => api.getProviderDetail(providerId, signal));
        if (!res) return;
        setDetail(res.provider);
        setLoadingDetail(false);
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : String(err));
        setLoadingDetail(false);
      }
    },
    [runLoadDetail],
  );

  const refreshAll = useCallback(
    async (preferredId?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const res = await runRefreshAll((signal) =>
          Promise.all([api.listProviders(signal), api.getProviderCatalog(signal)]),
        );
        if (!res) return;
        const [providersRes, catalogRes] = res;
        setProviders(providersRes.providers);
        setDiagnostics(providersRes.diagnostics ?? []);
        setCatalog(catalogRes);

        const fallbackId = selectedIdRef.current;
        const targetId =
          preferredId && providersRes.providers.some((item) => item.id === preferredId)
            ? preferredId
            : fallbackId && providersRes.providers.some((item) => item.id === fallbackId)
              ? fallbackId
              : sortProvidersForSidebar(providersRes.providers)[0]?.id;
        setSelectedId(targetId);
        setLoading(false);
        if (targetId) {
          await loadDetail(targetId);
        } else {
          setDetail(undefined);
          setDetailError(undefined);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    },
    [loadDetail, runRefreshAll],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const refreshMutated = useCallback(
    async (preferredId?: string) => {
      invalidateEngineModelsCache();
      await refreshAll(preferredId);
    },
    [refreshAll],
  );

  const oauth = useProviderOAuth({
    onComplete: refreshMutated,
    onError: setError,
    onSelectProvider: setSelectedId,
  });

  const handleSelectProvider = (providerId: string) => {
    if (providerId === selectedId) return;
    setSelectedId(providerId);
    void loadDetail(providerId);
  };

  const applyDetailChanged = async (next: ProviderDetail) => {
    abortLoadDetail();
    invalidateEngineModelsCache();
    setLoadingDetail(false);
    setDetailError(undefined);
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
      showToast(t("providers.toast.refreshFailed", { error: message }), "danger");
    }
  };

  const handleReloadModels = async () => {
    setReloading(true);
    setError(undefined);
    setReloadNotice(undefined);
    try {
      const res = await api.reloadModels();
      invalidateEngineModelsCache();
      setDiagnostics(res.diagnostics);
      setReloadNotice(
        t("providers.reloadNotice", { providers: res.providerCount, models: res.modelCount }),
      );
      await refreshAll(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  };

  return (
    <Section.Root className="ev-settings-section">
      <PageHeader.Root className="ev-section-header">
        <PageHeader.Row>
          <PageHeader.Title level={2} className="ev-section-title">
            {t("providers.title")}
          </PageHeader.Title>
          <PageHeader.Actions>
            <Button
              hierarchy="primary"
              density="compact"
              iconStart={<AddIcon width={15} height={15} />}
              onClick={() => setAddOpen(true)}
            >
              {t("providers.add")}
            </Button>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<SyncIcon width={15} height={15} />}
              pending={reloading}
              onClick={() => void handleReloadModels()}
            >
              {t("providers.reloadModels")}
            </Button>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<RefreshIcon width={15} height={15} />}
              pending={loading}
              onClick={() => void refreshMutated(selectedId)}
            >
              {t("common.refresh")}
            </Button>
          </PageHeader.Actions>
        </PageHeader.Row>
      </PageHeader.Root>

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
            <strong>{t("providers.diagnosticsHeading", { count: diagnostics.length })}</strong>
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
          loading={loading && providers.length === 0}
          filter={providerFilter}
          onFilterChange={setProviderFilter}
          category={category}
          onCategoryChange={setCategory}
          selectedId={selectedId}
          onSelect={handleSelectProvider}
        />

        <div className="ev-provider-detail-pane">
          {!selectedId && loading ? (
            <div className="ev-settings-card ev-skeleton-stack" aria-busy="true">
              <Skeleton className="ev-skeleton-title" />
              <SkeletonText lines={4} />
            </div>
          ) : !selectedId ? (
            <div className="ev-settings-card">
              <Text className="ev-inline-hint">{t("providers.selectPrompt")}</Text>
            </div>
          ) : loadingDetail && (!detail || detail.id !== selectedId) ? (
            <div className="ev-settings-card ev-skeleton-stack" aria-busy="true">
              <Skeleton className="ev-skeleton-title" />
              <SkeletonText lines={4} />
            </div>
          ) : detail && detail.id === selectedId ? (
            <div className="ev-form-stack">
              {detailError && <div className="ev-error-banner">{detailError}</div>}

              <ProviderAuthCard
                key={`auth:${detail.id}`}
                detail={detail}
                onRefresh={refreshMutated}
                onStartOAuth={(providerId) => void oauth.startOAuth(providerId)}
                onError={setError}
                onDetailError={setDetailError}
              />

              <ProviderConfigForm
                key={`config:${detail.id}`}
                detail={detail}
                supportedApis={catalog?.supportedApis ?? []}
                onSaved={applyDetailChanged}
                onDetailError={setDetailError}
              />

              <ProviderModelsList
                key={`models:${detail.id}`}
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
              void refreshMutated(providerId);
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
    </Section.Root>
  );
}
