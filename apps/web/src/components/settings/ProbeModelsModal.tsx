import { CloudDownloadIcon, RefreshIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Button, Modal, Text } from "@earendil-works/elanor-react";
import type { ProbedModel, ProviderDetail } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { formatTokens } from "../../lib/format.ts";

function modelKey(model: ProbedModel): string {
  return model.id;
}

export function ProbeModelsModal({
  providerId,
  onClose,
  onImported,
}: {
  readonly providerId: string;
  readonly onClose: () => void;
  readonly onImported: (provider: ProviderDetail) => void;
}) {
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

  const query = filter.trim().toLowerCase();
  const visibleModels = query
    ? models.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query))
    : models;
  const selectedModels = models.filter((model) => selected[modelKey(model)] === true);

  const importSelected = async () => {
    if (selectedModels.length === 0) return;
    setImporting(true);
    setError(undefined);
    try {
      const response = await api.importProviderModels(providerId, {
        models: selectedModels.map((model) => ({
          id: model.id,
          ...(model.name === undefined ? {} : { name: model.name }),
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.input === undefined ? {} : { input: [...model.input] }),
          ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        })),
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
            <Modal.Title>探测并导入模型 · {providerId}</Modal.Title>
            <Modal.Body className="ev-editor-body">
              <div className="ev-form-stack">
                <div className="ev-probe-toolbar">
                  <div className="ev-probe-search">
                    <SearchIcon width={14} height={14} />
                    <input
                      className="ev-raw-input"
                      value={filter}
                      placeholder="筛选探测结果…"
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    iconStart={<RefreshIcon width={14} height={14} />}
                    pending={probing}
                    onClick={() => void runProbe()}
                  >
                    重新探测
                  </Button>
                </div>
                {connectionNote && (
                  <div className="ev-connection-note" data-warning={connectionWarning}>
                    请求 URL：<span className="ev-mono">{connectionNote}</span>
                    {connectionWarning && <strong> 检测到可能的 /v1 重复</strong>}
                  </div>
                )}
                {catalogUrl && (
                  <div className="ev-inline-hint">
                    模型目录：<span className="ev-mono">{catalogUrl}</span>
                  </div>
                )}
                {probeError && <div className="ev-error-banner">{probeError}</div>}
                {error && <div className="ev-error-banner">{error}</div>}
                {truncated && (
                  <div>
                    <span className="eevee-badge" data-tone="warning">
                      结果已截断，请用筛选定位后导入
                    </span>
                  </div>
                )}
                {!probing && visibleModels.length === 0 && !probeError && (
                  <Text className="ev-inline-hint">没有可导入的模型。</Text>
                )}
                <div className="ev-probe-chip-grid">
                  {visibleModels.map((model) => {
                    const checked = selected[model.id] === true;
                    return (
                      <button
                        type="button"
                        key={model.id}
                        className="ev-probe-chip"
                        data-active={checked}
                        aria-pressed={checked}
                        onClick={() =>
                          setSelected((prev) => ({ ...prev, [model.id]: !prev[model.id] }))
                        }
                      >
                        <span className="ev-probe-chip-title ev-mono">{model.id}</span>
                        <span className="ev-probe-chip-meta">
                          {model.contextWindow !== undefined && formatTokens(model.contextWindow)}
                          {model.reasoning === true && " · reasoning"}
                          {model.input?.includes("image") === true && " · image"}
                          {model.exists && " · 已存在"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </Modal.Body>
            <Modal.Actions>
              <Modal.Close
                render={
                  <Button type="button" hierarchy="secondary">
                    取消
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
                导入所选（{selectedModels.length}）
              </Button>
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
