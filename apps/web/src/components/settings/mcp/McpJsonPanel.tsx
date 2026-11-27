import { CloseIcon, DownloadIcon, UploadIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, IconButton, TextArea } from "@earendil-works/elanor-react";
import { useState } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { parseImportJson } from "./codec.ts";

export type McpJsonPanelProps = {
  readonly isProject: boolean;
  readonly globalServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly projectServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly effectiveServers: Readonly<Record<string, Record<string, unknown>>>;
  readonly onImport: (servers: Record<string, Record<string, unknown>>) => Promise<void>;
  readonly onClose: () => void;
};

export function McpJsonPanel({
  isProject,
  globalServers,
  projectServers,
  effectiveServers,
  onImport,
  onClose,
}: McpJsonPanelProps) {
  const { t } = useI18n();
  const defaultExportSource = isProject ? projectServers : globalServers;
  const [jsonText, setJsonText] = useState(() =>
    JSON.stringify({ mcpServers: defaultExportSource }, null, 2),
  );
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleImport = async () => {
    setImporting(true);
    setError(undefined);
    try {
      const servers = parseImportJson(jsonText);
      await onImport(servers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={4} size={6}>
          {t(isProject ? "mcp.json.titleProject" : "mcp.json.titleGlobal")}
        </Heading>
        <div className="ev-inline-actions">
          {isProject && (
            <>
              <Button
                type="button"
                hierarchy="secondary"
                density="compact"
                onClick={() => setJsonText(JSON.stringify({ mcpServers: projectServers }, null, 2))}
              >
                {t("mcp.json.loadProjectOverrides")}
              </Button>
              <Button
                type="button"
                hierarchy="secondary"
                density="compact"
                onClick={() =>
                  setJsonText(JSON.stringify({ mcpServers: effectiveServers }, null, 2))
                }
              >
                {t("mcp.json.loadEffective")}
              </Button>
            </>
          )}
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<DownloadIcon width={14} height={14} />}
            onClick={() =>
              setJsonText(JSON.stringify({ mcpServers: defaultExportSource }, null, 2))
            }
          >
            {t("mcp.json.refreshExport")}
          </Button>
          <IconButton aria-label={t("mcp.json.closePanel")} onClick={onClose}>
            <CloseIcon width={16} height={16} />
          </IconButton>
        </div>
      </div>
      {error && <div className="ev-error-banner">{error}</div>}
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
          pending={importing}
          onClick={() => void handleImport()}
        >
          {t("mcp.json.importAndApply")}
        </Button>
        <Button type="button" hierarchy="secondary" density="compact" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
