import { DownloadIcon, UploadIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Heading, Input, Separator, TextArea } from "@earendil-works/elanor-react";
import type { ConfigBundle, EngineSettings, ModelChoice, ToolsSettings } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { resolveToolsSettings, ToolsSettingsEditor } from "./ToolsSettingsEditor.tsx";

function formatChoice(choice: ModelChoice | undefined): string {
  if (!choice) return "";
  return `${choice.provider}/${choice.modelId}${choice.thinkingLevel ? `:${choice.thinkingLevel}` : ""}`;
}

function parseChoice(raw: string): ModelChoice | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`模型格式无效："${trimmed}"，应为 provider/modelId`);
  }
  const provider = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (colon > 0 && thinkingLevels.has(rest.slice(colon + 1))) {
    return {
      provider,
      modelId: rest.slice(0, colon),
      thinkingLevel: rest.slice(colon + 1) as NonNullable<ModelChoice["thinkingLevel"]>,
    };
  }
  return { provider, modelId: rest };
}

export function ConfigTab() {
  const [maxActiveWorkers, setMaxActiveWorkers] = useState("3");
  const [backgroundAfterMs, setBackgroundAfterMs] = useState("30000");
  const [routerContextTokens, setRouterContextTokens] = useState("80000");
  const [idleHibernateMs, setIdleHibernateMs] = useState("600000");
  const [routerModel, setRouterModel] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [dreamerModel, setDreamerModel] = useState("");
  const [tools, setTools] = useState<ToolsSettings | undefined>(undefined);
  const [inlineBudget, setInlineBudget] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [bundleJson, setBundleJson] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const settings = await api.getSettings();
      setMaxActiveWorkers(String(settings.maxActiveWorkers ?? 3));
      setBackgroundAfterMs(String(settings.backgroundAfterMs ?? 30_000));
      setRouterContextTokens(String(settings.routerContextTokens ?? 80_000));
      setIdleHibernateMs(String(settings.idleHibernateMs ?? 600_000));
      setRouterModel(formatChoice(settings.models?.router));
      setWorkerModel(formatChoice(settings.models?.worker));
      setDreamerModel(formatChoice(settings.models?.dreamer));
      setTools(settings.tools);
      setInlineBudget(String(settings.tools?.codemode?.inlineBudget ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async () => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const router = parseChoice(routerModel);
      const worker = parseChoice(workerModel);
      const dreamer = parseChoice(dreamerModel);
      const models =
        router || worker || dreamer
          ? {
              ...(router ? { router } : {}),
              ...(worker ? { worker } : {}),
              ...(dreamer ? { dreamer } : {}),
            }
          : undefined;

      const nextTools = resolveToolsSettings(tools, inlineBudget, "global");
      const next: EngineSettings = {
        maxActiveWorkers: Number(maxActiveWorkers),
        backgroundAfterMs: Number(backgroundAfterMs),
        routerContextTokens: Number(routerContextTokens),
        idleHibernateMs: Number(idleHibernateMs),
        ...(models ? { models } : {}),
        ...(nextTools ? { tools: nextTools } : {}),
      };
      await api.putSettings(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      const bundle = await api.exportConfig();
      setBundleJson(JSON.stringify(bundle, null, 2));
      setNotice("已导出当前 Engine 配置（不含 auth.json 凭据）。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const parsed = JSON.parse(bundleJson) as ConfigBundle;
      await api.importConfig(parsed);
      await load();
      setNotice("配置导入成功并已热生效。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="ev-settings-section" style={{ gap: 22 }}>
      {error && <div className="ev-error-banner">{error}</div>}
      {notice && (
        <div>
          <span className="eevee-badge" data-tone="positive">
            {notice}
          </span>
        </div>
      )}

      <div className="ev-settings-section">
        <Heading level={2} size={5}>
          运行策略
        </Heading>

        <div className="ev-settings-card">
          <div className="ev-settings-grid-2">
            <Field.Root>
              <Field.Label>并发 Worker 上限</Field.Label>
              <Input type="text" value={maxActiveWorkers} onValueChange={setMaxActiveWorkers} />
            </Field.Root>
            <Field.Root>
              <Field.Label>命令转后台阈值 (ms)</Field.Label>
              <Input type="text" value={backgroundAfterMs} onValueChange={setBackgroundAfterMs} />
            </Field.Root>
            <Field.Root>
              <Field.Label>Router 记忆阈值 (tokens)</Field.Label>
              <Input
                type="text"
                value={routerContextTokens}
                onValueChange={setRouterContextTokens}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>空闲休眠 (ms)</Field.Label>
              <Input type="text" value={idleHibernateMs} onValueChange={setIdleHibernateMs} />
            </Field.Root>
          </div>

          <Separator />

          <div className="ev-settings-grid-3">
            <Field.Root>
              <Field.Label>Router 模型</Field.Label>
              <Input
                type="text"
                value={routerModel}
                onValueChange={setRouterModel}
                placeholder="provider/model"
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>Worker 模型</Field.Label>
              <Input
                type="text"
                value={workerModel}
                onValueChange={setWorkerModel}
                placeholder="跟随 Router"
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>Dreamer 模型</Field.Label>
              <Input
                type="text"
                value={dreamerModel}
                onValueChange={setDreamerModel}
                placeholder="未启用"
              />
            </Field.Root>
          </div>
        </div>
      </div>

      <div className="ev-settings-section">
        <Heading level={2} size={5}>
          工具与 Codemode
        </Heading>
        <div className="ev-settings-card">
          <ToolsSettingsEditor
            variant="global"
            value={tools}
            onChange={setTools}
            inlineBudget={inlineBudget}
            onInlineBudgetChange={setInlineBudget}
          />
          <Separator />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              hierarchy="primary"
              density="compact"
              pending={saving}
              onClick={() => void saveSettings()}
            >
              保存
            </Button>
            {saved && (
              <span className="eevee-badge" data-tone="positive">
                已保存
              </span>
            )}
          </div>
        </div>
      </div>

      <Separator />

      <div className="ev-settings-section">
        <div className="ev-settings-head">
          <Heading level={2} size={5}>
            配置导入导出
          </Heading>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<DownloadIcon width={15} height={15} />}
              onClick={() => void handleExport()}
            >
              导出
            </Button>
            <Button
              hierarchy="primary"
              density="compact"
              iconStart={<UploadIcon width={15} height={15} />}
              disabled={bundleJson.trim().length === 0}
              pending={importing}
              onClick={() => void handleImport()}
            >
              导入
            </Button>
          </div>
        </div>
        <TextArea
          monospace
          rows={10}
          value={bundleJson}
          onValueChange={setBundleJson}
          placeholder="ConfigBundle JSON"
        />
      </div>
    </div>
  );
}
