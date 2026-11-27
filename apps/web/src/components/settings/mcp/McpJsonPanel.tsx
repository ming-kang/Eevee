import { CloseIcon, DownloadIcon, UploadIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, IconButton, Text, TextArea } from "@earendil-works/elanor-react";
import { useState } from "react";
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
          {isProject ? "项目 MCP JSON 导入 / 导出" : "全局 MCP JSON 导入 / 导出"}
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
            onClick={() =>
              setJsonText(JSON.stringify({ mcpServers: defaultExportSource }, null, 2))
            }
          >
            刷新导出
          </Button>
          <IconButton aria-label="关闭 JSON 面板" onClick={onClose}>
            <CloseIcon width={16} height={16} />
          </IconButton>
        </div>
      </div>
      {error && <div className="ev-error-banner">{error}</div>}
      <Text className="ev-inline-hint">
        支持标准 <span className="ev-mono">{'{ "mcpServers": { ... } }'}</span>{" "}
        格式或直接服务映射。导入将整体替换
        {isProject ? "当前项目的 MCP 覆盖与项目独占配置" : "全局 MCP 配置"}。
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
          pending={importing}
          onClick={() => void handleImport()}
        >
          导入并应用
        </Button>
        <Button type="button" hierarchy="secondary" density="compact" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}
