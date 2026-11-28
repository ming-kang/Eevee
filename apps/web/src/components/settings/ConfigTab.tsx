import {
  CodeIcon,
  ContentCopyIcon,
  RefreshIcon,
  UndoIcon,
  UploadIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Input,
  Modal,
  PageHeader,
  Section,
  TextArea,
} from "@earendil-works/elanor-react";
import { ConfigBundleSchema, parseWithSchema } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../../lib/shortcut-stack.ts";
import { isMacPlatform } from "../../lib/shortcuts.ts";
import { showToast } from "../../lib/toasts.ts";
import { useAbortableAsync } from "../../lib/useAbortableAsync.ts";
import {
  refreshEngineSettingsAndModels,
  setCachedEngineSettings,
  useEngineSettingsAndModels,
} from "../../lib/useEngineSettings.ts";
import { ModelChoiceMenu } from "../ModelChoiceMenu.tsx";
import {
  buildEngineSettingsFromForm,
  type ConfigFormState,
  configFormFromSettings,
  formatTokenShorthand,
  hasConfigFormErrors,
  INITIAL_CONFIG_FORM_STATE,
  isConfigFormDirty,
  validateConfigForm,
} from "./config-form.ts";
import { ToolsSettingsEditor } from "./ToolsSettingsEditor.tsx";

export { buildEngineSettingsFromForm, type ConfigFormState, configFormFromSettings };

export function ConfigTab() {
  const { t } = useI18n();
  const { availableModels, refresh: refreshSharedModels } = useEngineSettingsAndModels(true);
  const [form, setForm] = useState<ConfigFormState>(INITIAL_CONFIG_FORM_STATE);
  const [savedForm, setSavedForm] = useState<ConfigFormState>(INITIAL_CONFIG_FORM_STATE);
  const [saving, setSaving] = useState(false);

  const [transferOpen, setTransferOpen] = useState(false);
  const [bundleJson, setBundleJson] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [transferError, setTransferError] = useState<string | undefined>(undefined);
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
      const loaded = configFormFromSettings(settings);
      setForm(loaded);
      setSavedForm(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  const fieldErrors = useMemo(() => validateConfigForm(form), [form]);
  const invalid = hasConfigFormErrors(fieldErrors);
  const dirty = useMemo(() => isConfigFormDirty(form, savedForm), [form, savedForm]);
  const memoryShorthand = formatTokenShorthand(form.routerContextTokens);

  const saveSettings = useCallback(async () => {
    if (saving || !dirty || invalid) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.putSettings(buildEngineSettingsFromForm(form));
      setCachedEngineSettings(updated);
      const nextSaved = configFormFromSettings(updated);
      setForm(nextSaved);
      setSavedForm(nextSaved);
      showToast(t("common.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [dirty, form, invalid, saving, t]);

  const discardChanges = useCallback(() => {
    setForm(savedForm);
    setError(undefined);
  }, [savedForm]);

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

  const loadExportBundle = useCallback(
    async (notify: boolean) => {
      setExporting(true);
      setTransferError(undefined);
      try {
        const bundle = await api.exportConfig();
        setBundleJson(JSON.stringify(bundle, null, 2));
        if (notify) showToast(t("config.exportedNotice"));
      } catch (err) {
        setTransferError(err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    },
    [t],
  );

  const openTransferModal = () => {
    setTransferOpen(true);
    void loadExportBundle(false);
  };

  const handleCopyBundle = async () => {
    if (!bundleJson.trim()) return;
    try {
      await navigator.clipboard.writeText(bundleJson);
      showToast(t("transcript.copied"));
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setTransferError(undefined);
    try {
      const parsed = parseWithSchema(ConfigBundleSchema, JSON.parse(bundleJson), "ConfigBundle");
      await api.importConfig(parsed);
      await load();
      await refreshEngineSettingsAndModels(true);
      setTransferOpen(false);
      showToast(t("config.importedNotice"));
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : String(err));
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
              {t("config.modelsTitle")}
            </PageHeader.Title>
            <PageHeader.Actions>
              <Button
                hierarchy="secondary"
                density="compact"
                iconStart={<CodeIcon width={15} height={15} />}
                onClick={openTransferModal}
              >
                {t("config.transferTitle")}
              </Button>
              {dirty && (
                <Button
                  hierarchy="tertiary"
                  density="compact"
                  iconStart={<UndoIcon width={14} height={14} />}
                  disabled={saving}
                  onClick={discardChanges}
                >
                  {t("config.discard")}
                </Button>
              )}
              <Button
                hierarchy="primary"
                density="compact"
                disabled={!dirty || invalid}
                pending={saving}
                onClick={() => void saveSettings()}
              >
                {t("common.save")}
              </Button>
            </PageHeader.Actions>
          </PageHeader.Row>
        </PageHeader.Root>

        {error && <div className="ev-error-banner">{error}</div>}

        <div className="ev-settings-card">
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
              {t("config.runPolicyTitle")}
            </PageHeader.Title>
          </PageHeader.Row>
        </PageHeader.Root>

        <div className="ev-settings-card">
          <div className="ev-settings-grid-2">
            <Field.Root>
              <Field.Label>{t("config.maxActiveWorkers")}</Field.Label>
              <div className="ev-unit-input">
                <Input
                  className="ev-unit-input-control"
                  type="text"
                  inputMode="numeric"
                  aria-invalid={fieldErrors.maxActiveWorkers ? true : undefined}
                  value={form.maxActiveWorkers}
                  onValueChange={(maxActiveWorkers) => patchForm({ maxActiveWorkers })}
                />
                <span className="ev-unit-suffix" aria-hidden="true">
                  {t("config.unit.workers")}
                </span>
              </div>
              {fieldErrors.maxActiveWorkers ? (
                <p className="ev-inline-error">{fieldErrors.maxActiveWorkers}</p>
              ) : (
                <p className="ev-inline-hint">{t("config.maxActiveWorkersHint")}</p>
              )}
            </Field.Root>

            <Field.Root>
              <Field.Label>{t("config.backgroundAfter")}</Field.Label>
              <div className="ev-unit-input">
                <Input
                  className="ev-unit-input-control"
                  type="text"
                  inputMode="decimal"
                  aria-invalid={fieldErrors.backgroundAfterSec ? true : undefined}
                  value={form.backgroundAfterSec}
                  onValueChange={(backgroundAfterSec) => patchForm({ backgroundAfterSec })}
                />
                <span className="ev-unit-suffix ev-mono" aria-hidden="true">
                  s
                </span>
              </div>
              {fieldErrors.backgroundAfterSec ? (
                <p className="ev-inline-error">{fieldErrors.backgroundAfterSec}</p>
              ) : (
                <p className="ev-inline-hint">{t("config.backgroundAfterHint")}</p>
              )}
            </Field.Root>

            <Field.Root>
              <Field.Label>
                <span className="ev-field-label-row">
                  <span>{t("config.routerContextTokens")}</span>
                  {memoryShorthand && (
                    <span className="ev-field-label-meta ev-mono">{memoryShorthand}</span>
                  )}
                </span>
              </Field.Label>
              <div className="ev-unit-input">
                <Input
                  className="ev-unit-input-control"
                  type="text"
                  inputMode="numeric"
                  aria-invalid={fieldErrors.routerContextTokens ? true : undefined}
                  value={form.routerContextTokens}
                  onValueChange={(routerContextTokens) => patchForm({ routerContextTokens })}
                />
                <span className="ev-unit-suffix ev-mono" aria-hidden="true">
                  tokens
                </span>
              </div>
              {fieldErrors.routerContextTokens ? (
                <p className="ev-inline-error">{fieldErrors.routerContextTokens}</p>
              ) : (
                <p className="ev-inline-hint">{t("config.routerContextTokensHint")}</p>
              )}
            </Field.Root>

            <Field.Root>
              <Field.Label>{t("config.idleHibernate")}</Field.Label>
              <div className="ev-unit-input">
                <Input
                  className="ev-unit-input-control"
                  type="text"
                  inputMode="decimal"
                  aria-invalid={fieldErrors.idleHibernateMin ? true : undefined}
                  value={form.idleHibernateMin}
                  onValueChange={(idleHibernateMin) => patchForm({ idleHibernateMin })}
                />
                <span className="ev-unit-suffix ev-mono" aria-hidden="true">
                  min
                </span>
              </div>
              {fieldErrors.idleHibernateMin ? (
                <p className="ev-inline-error">{fieldErrors.idleHibernateMin}</p>
              ) : (
                <p className="ev-inline-hint">{t("config.idleHibernateHint")}</p>
              )}
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
              inlineBudgetError={fieldErrors.inlineBudget}
            />
          </div>
        </Section.Content>
      </Section.Root>

      {dirty && (
        <div className="ev-sticky-save-bar" role="status" aria-live="polite">
          <div className="ev-sticky-save-status">
            <span className="ev-sticky-save-dot" aria-hidden="true" />
            <span>{t("config.unsavedChanges")}</span>
          </div>
          <div className="ev-inline-actions">
            <Button
              hierarchy="tertiary"
              density="compact"
              disabled={saving}
              onClick={discardChanges}
            >
              {t("config.discard")}
            </Button>
            <Button
              hierarchy="primary"
              density="compact"
              disabled={invalid}
              pending={saving}
              onClick={() => void saveSettings()}
            >
              {t("config.saveWithShortcut", { shortcut: isMacPlatform() ? "⌘S" : "Ctrl+S" })}
            </Button>
          </div>
        </div>
      )}

      <Modal.Root open={transferOpen} onOpenChange={(open) => !importing && setTransferOpen(open)}>
        <Modal.Portal>
          <Modal.Backdrop />
          <Modal.Viewport>
            <Modal.Popup className="ev-transfer-dialog">
              <Modal.Title>{t("config.transferTitle")}</Modal.Title>
              <Modal.Body className="ev-form-stack">
                {transferError && <div className="ev-error-banner">{transferError}</div>}
                <div className="ev-settings-head">
                  <p className="ev-inline-hint">{t("config.transferHint")}</p>
                  <div className="ev-inline-actions">
                    <Button
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<ContentCopyIcon width={14} height={14} />}
                      disabled={bundleJson.trim().length === 0 || exporting}
                      onClick={() => void handleCopyBundle()}
                    >
                      {t("config.copyJson")}
                    </Button>
                    <Button
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<RefreshIcon width={14} height={14} />}
                      pending={exporting}
                      onClick={() => void loadExportBundle(true)}
                    >
                      {t("config.export")}
                    </Button>
                  </div>
                </div>
                <TextArea
                  monospace
                  rows={12}
                  value={bundleJson}
                  onValueChange={setBundleJson}
                  placeholder="ConfigBundle JSON"
                />
              </Modal.Body>
              <Modal.Actions className="ev-editor-actions">
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary" disabled={importing}>
                      {t("common.close")}
                    </Button>
                  }
                />
                <Button
                  hierarchy="primary"
                  iconStart={<UploadIcon width={15} height={15} />}
                  disabled={bundleJson.trim().length === 0 || exporting}
                  pending={importing}
                  onClick={() => void handleImport()}
                >
                  {t("config.import")}
                </Button>
              </Modal.Actions>
            </Modal.Popup>
          </Modal.Viewport>
        </Modal.Portal>
      </Modal.Root>
    </div>
  );
}
