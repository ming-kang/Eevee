import { ExperimentIcon } from "@earendil-works/elanor-icons-react";
import { Button, Modal } from "@earendil-works/elanor-react";
import type { CompatFieldInfo, ProviderDetail, ThinkingLevel } from "@eevee/protocol";
import { type FormEvent, useReducer, useState } from "react";
import { api } from "../../lib/api.ts";
import { useI18n } from "../../lib/i18n.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { EvDropdown } from "../EvDropdown.tsx";
import { ModelBasicSection } from "./model-editor/ModelBasicSection.tsx";
import { ModelBuiltinMatcher } from "./model-editor/ModelBuiltinMatcher.tsx";
import { ModelCompatSection } from "./model-editor/ModelCompatSection.tsx";
import {
  buildModelUpsertRequest,
  createModelEditorDraft,
  type ModelEditorTarget,
  modelEditorReducer,
} from "./model-editor/state.ts";
import { SmokeTestResult } from "./SmokeTestResult.tsx";
import { ThinkingLevelsEditor } from "./ThinkingLevelsEditor.tsx";
import { modelSmokeKey, useModelSmokeTests } from "./useModelSmokeTests.ts";

export type { ModelEditorTarget };

export function ModelEditorModal({
  target,
  compatSchemas,
  onClose,
  onProviderChanged,
}: {
  readonly target: ModelEditorTarget;
  readonly compatSchemas: Record<string, CompatFieldInfo[]>;
  readonly onClose: () => void;
  readonly onProviderChanged: (provider: ProviderDetail) => void;
}) {
  const { t } = useI18n();
  const model = target.model;
  const isCreate = model === undefined;
  const isCustom = isCreate || model.isCustom;

  const [draft, dispatch] = useReducer(modelEditorReducer, undefined, () =>
    createModelEditorDraft(target, compatSchemas),
  );
  const [testLevel, setTestLevel] = useState<"" | ThinkingLevel>("");
  const [testTools, setTestTools] = useState(false);
  const { tests, runTest } = useModelSmokeTests();

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const effectiveApi = (draft.apiValue.trim() || model?.api || target.providerApi || "").trim();
  const compatFields = compatSchemas[effectiveApi] ?? [];
  const smoke = model ? tests[modelSmokeKey(target.providerId, model.id)] : undefined;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const request = buildModelUpsertRequest(target, draft, compatFields);
      const response = isCreate
        ? await api.createProviderModel(target.providerId, request)
        : await api.updateProviderModel(target.providerId, model.id, request);
      onProviderChanged(response.provider);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async () => {
    if (!model) return;
    setDeleting(true);
    setConfirmError(undefined);
    try {
      const response = await api.deleteProviderModel(target.providerId, model.id);
      onProviderChanged(response.provider);
      setConfirmOpen(false);
      onClose();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const runSmokeTest = () => {
    if (!model) return;
    void runTest(target.providerId, model.id, {
      ...(testLevel ? { thinkingLevel: testLevel } : {}),
      ...(testTools ? { testTools: true } : {}),
    });
  };

  const title = isCreate
    ? t("modelEditor.titleCreate")
    : t("modelEditor.titleEdit", { id: model.id });

  return (
    <Modal.Root open onOpenChange={(open) => !open && !confirmOpen && !deleting && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-editor-dialog">
            <Modal.Title>{title}</Modal.Title>
            <form noValidate onSubmit={(event) => void save(event)} className="ev-form-stack">
              {error && (
                <div className="ev-error-banner" style={{ flex: "none" }}>
                  {error}
                </div>
              )}
              <Modal.Body className="ev-editor-body">
                <div className="ev-form-stack">
                  <ModelBasicSection
                    target={target}
                    isCreate={isCreate}
                    isCustom={isCustom}
                    supportedApis={Object.keys(compatSchemas)}
                    draft={draft}
                    dispatch={dispatch}
                  />

                  {draft.reasoning && (
                    <section className="ev-editor-section">
                      <div className="ev-editor-section-title">
                        {t("modelEditor.thinkingSection")}
                      </div>
                      <ThinkingLevelsEditor
                        value={draft.thinkingLevels}
                        onChange={(thinkingLevels) =>
                          dispatch({ type: "patch", patch: { thinkingLevels } })
                        }
                        showInheritedBadges={!isCustom}
                      />
                    </section>
                  )}

                  {isCustom && !isCreate && (
                    <ModelBuiltinMatcher
                      providerId={target.providerId}
                      model={model}
                      modelId={draft.modelId}
                      onApplyDiffs={(diffs) =>
                        dispatch({ type: "applyCandidateDiffs", diffs, compatFields })
                      }
                    />
                  )}

                  {effectiveApi && (
                    <ModelCompatSection
                      compatFields={compatFields}
                      draft={draft}
                      dispatch={dispatch}
                    />
                  )}

                  {model && (
                    <section className="ev-editor-section">
                      <div className="ev-editor-section-title">{t("modelEditor.smokeSection")}</div>
                      <div className="ev-smoke-controls">
                        <EvDropdown
                          density="compact"
                          className="ev-smoke-thinking-select"
                          ariaLabel="Thinking"
                          value={testLevel}
                          options={[
                            { value: "", label: t("modelEditor.smokeDefaultThinking") },
                            ...model.supportedThinkingLevels.map((level) => ({
                              value: level,
                              label: level,
                            })),
                          ]}
                          onChange={(next) => setTestLevel(next as "" | ThinkingLevel)}
                        />
                        <label className="ev-check-row">
                          <input
                            type="checkbox"
                            className="ev-native-checkbox"
                            checked={testTools}
                            onChange={(event) => setTestTools(event.target.checked)}
                          />
                          {t("modelEditor.smokeTestTools")}
                        </label>
                        <Button
                          type="button"
                          hierarchy="secondary"
                          density="compact"
                          iconStart={<ExperimentIcon width={14} height={14} />}
                          pending={smoke?.loading === true}
                          onClick={runSmokeTest}
                        >
                          {t("modelEditor.smokeTestButton")}
                        </Button>
                      </div>
                      {smoke?.error && <div className="ev-error-banner">{smoke.error}</div>}
                      {smoke?.result && <SmokeTestResult result={smoke.result} />}
                    </section>
                  )}
                </div>
              </Modal.Body>
              <Modal.Actions className="ev-editor-actions">
                <div className="ev-editor-actions-start">
                  {model?.isCustom && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      pending={deleting}
                      onClick={() => {
                        setConfirmError(undefined);
                        setConfirmOpen(true);
                      }}
                    >
                      {t("modelEditor.deleteModel")}
                    </Button>
                  )}
                  {model && !model.isCustom && model.hasOverride && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      pending={deleting}
                      onClick={() => {
                        setConfirmError(undefined);
                        setConfirmOpen(true);
                      }}
                    >
                      {t("modelEditor.revertBuiltin")}
                    </Button>
                  )}
                </div>
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary">
                      {t("common.cancel")}
                    </Button>
                  }
                />
                <Button type="submit" hierarchy="primary" pending={saving}>
                  {t("common.save")}
                </Button>
              </Modal.Actions>
            </form>
            {model && (
              <ConfirmModal
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title={
                  model.isCustom
                    ? t("modelEditor.confirmDeleteTitle", { id: model.id })
                    : t("modelEditor.confirmRevertTitle", { id: model.id })
                }
                description={
                  model.isCustom
                    ? t("modelEditor.confirmDeleteDesc")
                    : t("modelEditor.confirmRevertDesc")
                }
                confirmLabel={
                  model.isCustom
                    ? t("modelEditor.confirmDeleteLabel")
                    : t("modelEditor.confirmRevertLabel")
                }
                tone="danger"
                pending={deleting}
                error={confirmError}
                onConfirm={removeModel}
              />
            )}
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
