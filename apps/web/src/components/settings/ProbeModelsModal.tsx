import { CloudDownloadIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import { Button, Modal } from "@earendil-works/elanor-react";
import type { ProbedModel, ProviderDetail } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.ts";
import { ModelProbeSelector } from "./ModelProbeSelector.tsx";
import { toImportModelPayload } from "./provider-utils.ts";

export function ProbeModelsModal({
  providerId,
  onClose,
  onImported,
}: {
  readonly providerId: string;
  readonly onClose: () => void;
  readonly onImported: (provider: ProviderDetail) => void;
}) {
  const { t } = useI18n();
  const [models, setModels] = useState<ProbedModel[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [probeError, setProbeError] = useState<string | undefined>(undefined);
  const [catalogUrl, setCatalogUrl] = useState<string | undefined>(undefined);
  const [connectionNote, setConnectionNote] = useState<string | undefined>(undefined);
  const [connectionWarning, setConnectionWarning] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [probing, setProbing] = useState(true);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError(undefined);
    setError(undefined);
    try {
      const response = await api.probeProvider(providerId);
      setModels(response.models);
      setCatalogUrl(response.catalogUrl);
      setConnectionNote(response.connectionNote?.text);
      setConnectionWarning(response.connectionNote?.warning === true);
      setTruncated(response.truncated);
      setProbeError(response.error);
      setSelected(Object.fromEntries(response.models.map((model) => [model.id, !model.exists])));
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
      setModels([]);
    } finally {
      setProbing(false);
    }
  }, [providerId]);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  const selectedModels = models.filter((model) => selected[model.id] === true);

  const importSelected = async () => {
    if (selectedModels.length === 0) return;
    setImporting(true);
    setError(undefined);
    try {
      const response = await api.importProviderModels(providerId, {
        models: selectedModels.map(toImportModelPayload),
      });
      onImported(response.provider);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-probe-dialog">
            <Modal.Title>{t("probe.modalTitle", { providerId })}</Modal.Title>
            <Modal.Body className="ev-editor-body">
              <div className="ev-form-stack">
                <ModelProbeSelector
                  models={models}
                  selected={selected}
                  onSelectedChange={setSelected}
                  filter={filter}
                  onFilterChange={setFilter}
                  filterPlaceholder={t("probe.filterPlaceholder")}
                  emptyText={t("probe.empty")}
                  variant="chips"
                  loading={probing}
                  suppressEmpty={Boolean(probeError)}
                  toolbarActions={
                    <Button
                      type="button"
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<RefreshIcon width={14} height={14} />}
                      pending={probing}
                      onClick={() => void runProbe()}
                    >
                      {t("probe.reprobe")}
                    </Button>
                  }
                  statusSlot={
                    <>
                      {connectionNote && (
                        <div className="ev-connection-note" data-warning={connectionWarning}>
                          {t("probe.requestUrlLabel")}
                          <span className="ev-mono">{connectionNote}</span>
                          {connectionWarning && <strong>{t("probe.duplicateV1Warning")}</strong>}
                        </div>
                      )}
                      {catalogUrl && (
                        <div className="ev-inline-hint">
                          {t("probe.catalogUrlLabel")}
                          <span className="ev-mono">{catalogUrl}</span>
                        </div>
                      )}
                      {probeError && <div className="ev-error-banner">{probeError}</div>}
                      {error && <div className="ev-error-banner">{error}</div>}
                      {truncated && (
                        <div>
                          <span className="eevee-badge" data-tone="warning">
                            {t("probe.truncatedWarning")}
                          </span>
                        </div>
                      )}
                    </>
                  }
                />
              </div>
            </Modal.Body>
            <Modal.Actions>
              <Modal.Close
                render={
                  <Button type="button" hierarchy="secondary">
                    {t("common.cancel")}
                  </Button>
                }
              />
              <Button
                type="button"
                hierarchy="primary"
                iconStart={<CloudDownloadIcon width={15} height={15} />}
                disabled={selectedModels.length === 0}
                pending={importing}
                onClick={() => void importSelected()}
              >
                {t("probe.importSelected", { count: selectedModels.length })}
              </Button>
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
