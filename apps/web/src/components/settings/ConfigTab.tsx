import { CodeIcon, DownloadIcon, UploadIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Heading,
  Input,
  PageHeader,
  Section,
  Separator,
  TextArea,
} from "@earendil-works/elanor-react";
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
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../../lib/shortcut-stack.ts";
import { showToast } from "../../lib/toasts.ts";
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

  const [transferOpen, setTransferOpen] = useState(false);
  const [bundleJson, setBundleJson] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const { run: runLoad } = useAbortableAsync();

  const patchForm = (patch: Partial<ConfigFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
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

  const saveSettings = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.putSettings(buildEngineSettingsFromForm(form));
      setCachedEngineSettings(updated);
      showToast(t("common.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, saving, t]);

  useShortcutLayer({
    id: "config-tab-save",
    active: true,
    priority: SHORTCUT_PRIORITY.OVERLAY,
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveSettings();
        return true;
      }
      return false;
    },
  });

  const handleExport = async () => {
    setError(undefined);
    setTransferOpen(true);
    try {
      const bundle = await api.exportConfig();
      setBundleJson(JSON.stringify(bundle, null, 2));
      showToast(t("config.exportedNotice"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(undefined);
    try {
      const parsed = parseWithSchema(ConfigBundleSchema, JSON.parse(bundleJson), "ConfigBundle");
      await api.importConfig(parsed);
      await load();
      await refreshEngineSettingsAndModels(true);
      setTransferOpen(false);
      showToast(t("config.importedNotice"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="ev-settings-stack ev-settings-narrow">
      <Section.Root className="ev-settings-section">
        <PageHeader.Root className="ev-section-header">
          <PageHeader.Row>
            <PageHeader.Title level={2} className="ev-section-title">
              {t("config.runPolicyTitle")}
            </PageHeader.Title>
            <PageHeader.Actions>
              <Button
                hierarchy="secondary"
                density="compact"
                iconStart={<CodeIcon width={15} height={15} />}
                onClick={() => setTransferOpen((prev) => !prev)}
              >
                {t("config.transferTitle")}
              </Button>
              <Button
                hierarchy="primary"
                density="compact"
                pending={saving}
                onClick={() => void saveSettings()}
              >
                {t("common.save")}
              </Button>
            </PageHeader.Actions>
          </PageHeader.Row>
        </PageHeader.Root>

        {error && <div className="ev-error-banner">{error}</div>}

        {transferOpen && (
          <div className="ev-settings-card">
            <div className="ev-settings-head">
              <Heading level={3} size={6}>
                {t("config.transferTitle")}
              </Heading>
              <div className="ev-inline-actions">
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
        )}

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
      </Section.Root>

      <Section.Root className="ev-settings-section">
        <PageHeader.Root className="ev-section-header">
          <PageHeader.Row>
            <PageHeader.Title level={2} className="ev-section-title">
              {t("config.toolsTitle")}
            </PageHeader.Title>
          </PageHeader.Row>
        </PageHeader.Root>
        <Section.Content>
          <div className="ev-settings-card">
            <ToolsSettingsEditor
              variant="global"
              value={form.tools}
              onChange={(tools) => patchForm({ tools })}
              inlineBudget={form.inlineBudget}
              onInlineBudgetChange={(inlineBudget) => patchForm({ inlineBudget })}
            />
          </div>
        </Section.Content>
      </Section.Root>
    </div>
  );
}
