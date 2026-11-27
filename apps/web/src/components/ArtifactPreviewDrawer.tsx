import { CloseIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import { CopyButton, Drawer, IconButton, Tabs } from "@earendil-works/elanor-react";
import { useEffect, useMemo, useState } from "react";
import {
  buildArtifactSrcDoc,
  type PreviewArtifact,
  readHostThemeColors,
} from "../lib/artifact-preview.ts";
import { useI18n } from "../lib/i18n.ts";
import { EvTooltip } from "./EvTooltip.tsx";

export function ArtifactPreviewDrawer({
  artifact,
  onClose,
}: {
  readonly artifact: PreviewArtifact | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [themeRevision, setThemeRevision] = useState(0);

  useEffect(() => {
    if (!artifact) return;
    setTab("preview");
    setReloadNonce(0);
  }, [artifact]);

  useEffect(() => {
    if (!artifact || typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => {
      setThemeRevision((n) => n + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-scheme", "data-theme-preset"],
    });
    return () => observer.disconnect();
  }, [artifact]);

  const srcDoc = useMemo(() => {
    void themeRevision;
    if (!artifact) return "";
    return buildArtifactSrcDoc(artifact, readHostThemeColors());
  }, [artifact, themeRevision]);

  return (
    <Drawer.Root
      open={artifact !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      swipeDirection="right"
    >
      <Drawer.Portal>
        <Drawer.Backdrop className="ev-artifact-backdrop" />
        <Drawer.Viewport className="ev-artifact-viewport">
          <Drawer.Popup className="ev-artifact-drawer">
            <div className="ev-artifact-head">
              <div className="ev-artifact-title-group">
                <Drawer.Title className="ev-artifact-title">
                  {artifact?.title ?? t("artifact.previewTitle")}
                </Drawer.Title>
                {artifact && <span className="eevee-badge ev-mono">{artifact.kind}</span>}
              </div>

              <div className="ev-artifact-head-actions">
                {tab === "preview" && (
                  <EvTooltip content={t("artifact.reload")} side="bottom">
                    <IconButton
                      aria-label={t("artifact.reload")}
                      onClick={() => setReloadNonce((n) => n + 1)}
                    >
                      <RefreshIcon width={16} height={16} />
                    </IconButton>
                  </EvTooltip>
                )}
                {artifact && (
                  <CopyButton value={artifact.code} aria-label={t("transcript.copyCode")} />
                )}
                <EvTooltip content={t("common.close")} side="bottom">
                  <IconButton aria-label={t("common.close")} onClick={onClose}>
                    <CloseIcon width={18} height={18} />
                  </IconButton>
                </EvTooltip>
              </div>
            </div>

            <div className="ev-artifact-tabs-bar">
              <Tabs.Root
                className="ev-header-tabs-root"
                value={tab}
                onValueChange={(next) => {
                  if (next === "preview" || next === "source") setTab(next);
                }}
              >
                <Tabs.List className="ev-header-tabs">
                  <Tabs.Tab value="preview" className="ev-header-tab">
                    {t("artifact.tab.preview")}
                  </Tabs.Tab>
                  <Tabs.Tab value="source" className="ev-header-tab">
                    {t("artifact.tab.source")}
                  </Tabs.Tab>
                  <Tabs.Indicator className="ev-header-tabs-indicator" />
                </Tabs.List>
              </Tabs.Root>
            </div>

            <div className="ev-artifact-body">
              {artifact && tab === "preview" ? (
                <iframe
                  key={`${artifact.kind}:${reloadNonce}:${themeRevision}`}
                  className="ev-artifact-frame"
                  title={artifact.title}
                  sandbox="allow-scripts"
                  srcDoc={srcDoc}
                />
              ) : artifact ? (
                <pre className="ev-artifact-source ev-mono">
                  <code>{artifact.code}</code>
                </pre>
              ) : null}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
