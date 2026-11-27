import { DownloadIcon, UploadIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Heading, Input, Separator, TextArea } from "@earendil-works/elanor-react";
import {
  ConfigBundleSchema,
  type EngineSettings,
  type ModelChoice,
  parseWithSchema,
  type ToolsSettings,
} from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.ts";
import { useAbortableAsync } from "../../lib/useAbortableAsync.ts";
import {
  refreshEngineSettingsAndModels,
  setCachedEngineSettings,
  useEngineSettingsAndModels,
} from "../../lib/useEngineSettings.ts";
import { ModelChoiceMenu } from "../ModelChoiceMenu.tsx";
import { resolveToolsSettings, ToolsSettingsEditor } from "./ToolsSettingsEditor.tsx";

export type ConfigFormState = {
  readonly maxActiveWorkers: string;
  readonly backgroundAfterMs: string;
  readonly routerContextTokens: string;
  readonly idleHibernateMs: string;
  readonly routerModel: ModelChoice | undefined;
  readonly workerModel: ModelChoice | undefined;
  readonly dreamerModel: ModelChoice | undefined;
  readonly tools: ToolsSettings | undefined;
  readonly inlineBudget: string;
};

const INITIAL_FORM_STATE: ConfigFormState = {
  maxActiveWorkers: "3",
  backgroundAfterMs: "30000",
  routerContextTokens: "80000",
  idleHibernateMs: "600000",
  routerModel: undefined,
  workerModel: undefined,
  dreamerModel: undefined,
  tools: undefined,
  inlineBudget: "",
};

export function configFormFromSettings(settings: EngineSettings): ConfigFormState {
  return {
    maxActiveWorkers: String(settings.maxActiveWorkers ?? 3),
    backgroundAfterMs: String(settings.backgroundAfterMs ?? 30_000),
    routerContextTokens: String(settings.routerContextTokens ?? 80_000),
    idleHibernateMs: String(settings.idleHibernateMs ?? 600_000),
    routerModel: settings.models?.router,
    workerModel: settings.models?.worker,
    dreamerModel: settings.models?.dreamer,
    tools: settings.tools,
    inlineBudget: String(settings.tools?.codemode?.inlineBudget ?? ""),
  };
}

export function buildEngineSettingsFromForm(form: ConfigFormState): EngineSettings {
  const models =
    form.routerModel || form.workerModel || form.dreamerModel
      ? {
          ...(form.routerModel ? { router: form.routerModel } : {}),
          ...(form.workerModel ? { worker: form.workerModel } : {}),
          ...(form.dreamerModel ? { dreamer: form.dreamerModel } : {}),
        }
      : undefined;

  const nextTools = resolveToolsSettings(form.tools, form.inlineBudget, "global");
  return {
    maxActiveWorkers: Number(form.maxActiveWorkers),
    backgroundAfterMs: Number(form.backgroundAfterMs),
    routerContextTokens: Number(form.routerContextTokens),
    idleHibernateMs: Number(form.idleHibernateMs),
    ...(models ? { models } : {}),
    ...(nextTools ? { tools: nextTools } : {}),
  };
}

export function ConfigTab() {
  const { t } = useI18n();
  const { availableModels, refresh: refreshSharedModels } = useEngineSettingsAndModels(true);
  const [form, setForm] = useState<ConfigFormState>(INITIAL_FORM_STATE);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [bundleJson, setBundleJson] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const { run: runLoad } = useAbortableAsync();

  const patchForm = (patch: Partial<ConfigFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const settings = await runLoad((signal) => api.getSettings(signal));
      if (!settings) return;
      setCachedEngineSettings(settings);
      setForm(configFormFromSettings(settings));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async () => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const updated = await api.putSettings(buildEngineSettingsFromForm(form));
      setCachedEngineSettings(updated);
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
      setNotice(t("config.exportedNotice"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const parsed = parseWithSchema(ConfigBundleSchema, JSON.parse(bundleJson), "ConfigBundle");
      await api.importConfig(parsed);
      await load();
      await refreshEngineSettingsAndModels(true);
      setNotice(t("config.importedNotice"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="ev-settings-section" style={{ gap: 22 }}>
      {error && <div className="ev-error-banner">{error}</div>}
      {notice && <div className="ev-info-banner">{notice}</div>}

      <div className="ev-settings-section">
        <Heading level={2} size={5}>
          {t("config.runPolicyTitle")}
        </Heading>
        <div className="ev-settings-card">
          <div className="ev-settings-grid-2">
            <Field.Root>
              <Field.Label>{t("config.maxActiveWorkers")}</Field.Label>
              <Input
                type="text"
                value={form.maxActiveWorkers}
                onValueChange={(maxActiveWorkers) => patchForm({ maxActiveWorkers })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>{t("config.backgroundAfterMs")}</Field.Label>
              <Input
                type="text"
                value={form.backgroundAfterMs}
                onValueChange={(backgroundAfterMs) => patchForm({ backgroundAfterMs })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>{t("config.routerContextTokens")}</Field.Label>
              <Input
                type="text"
                value={form.routerContextTokens}
                onValueChange={(routerContextTokens) => patchForm({ routerContextTokens })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>{t("config.idleHibernateMs")}</Field.Label>
              <Input
                type="text"
                value={form.idleHibernateMs}
                onValueChange={(idleHibernateMs) => patchForm({ idleHibernateMs })}
              />
            </Field.Root>
          </div>

          <Separator />

          <div className="ev-settings-grid-3">
            <Field.Root>
              <Field.Label>{t("config.routerModel")}</Field.Label>
              <ModelChoiceMenu
                value={form.routerModel}
                models={availableModels}
                placeholder={t("modelMenu.choose")}
                variant="field"
                ariaLabel={t("config.routerModel")}
                onOpen={() => void refreshSharedModels(false)}
                onChange={(routerModel) => patchForm({ routerModel })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>{t("config.workerModel")}</Field.Label>
              <ModelChoiceMenu
                value={form.workerModel}
                models={availableModels}
                placeholder={t("modelMenu.followRouter")}
                clearLabel={t("modelMenu.followRouter")}
                variant="field"
                ariaLabel={t("config.workerModel")}
                onOpen={() => void refreshSharedModels(false)}
                onChange={(workerModel) => patchForm({ workerModel })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>{t("config.dreamerModel")}</Field.Label>
              <ModelChoiceMenu
                value={form.dreamerModel}
                models={availableModels}
                placeholder={t("modelMenu.disabled")}
                clearLabel={t("modelMenu.disabled")}
                variant="field"
                align="end"
                ariaLabel={t("config.dreamerModel")}
                onOpen={() => void refreshSharedModels(false)}
                onChange={(dreamerModel) => patchForm({ dreamerModel })}
              />
            </Field.Root>
          </div>
        </div>
      </div>

      <div className="ev-settings-section">
        <Heading level={2} size={5}>
          {t("config.toolsTitle")}
        </Heading>
        <div className="ev-settings-card">
          <ToolsSettingsEditor
            variant="global"
            value={form.tools}
            onChange={(tools) => patchForm({ tools })}
            inlineBudget={form.inlineBudget}
            onInlineBudgetChange={(inlineBudget) => patchForm({ inlineBudget })}
          />
          <Separator />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              hierarchy="primary"
              density="compact"
              pending={saving}
              onClick={() => void saveSettings()}
            >
              {t("common.save")}
            </Button>
            {saved && (
              <span className="eevee-badge" data-tone="positive">
                {t("common.saved")}
              </span>
            )}
          </div>
        </div>
      </div>

      <Separator />

      <div className="ev-settings-section">
        <div className="ev-settings-head">
          <Heading level={2} size={5}>
            {t("config.transferTitle")}
          </Heading>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              hierarchy="secondary"
              density="compact"
              iconStart={<DownloadIcon width={15} height={15} />}
              onClick={() => void handleExport()}
            >
              {t("config.export")}
            </Button>
            <Button
              hierarchy="primary"
              density="compact"
              iconStart={<UploadIcon width={15} height={15} />}
              disabled={bundleJson.trim().length === 0}
              pending={importing}
              onClick={() => void handleImport()}
            >
              {t("config.import")}
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
