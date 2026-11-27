import { ExperimentIcon } from "@earendil-works/elanor-icons-react";
import { Button, Modal, Text } from "@earendil-works/elanor-react";
import type { CompatFieldInfo, ProviderDetail, ThinkingLevel } from "@eevee/protocol";
import { type FormEvent, useReducer, useState } from "react";
import { api } from "../../lib/api.ts";
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
    const label = model.isCustom
      ? `删除模型「${model.id}」？`
      : `还原「${model.id}」的内置默认配置？`;
    if (!window.confirm(label)) return;
    setDeleting(true);
    setError(undefined);
    try {
      const response = await api.deleteProviderModel(target.providerId, model.id);
      onProviderChanged(response.provider);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const title = isCreate ? "新增模型" : `编辑模型 · ${model.id}`;

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-editor-dialog">
            <Modal.Title>{title}</Modal.Title>
            <form onSubmit={(event) => void save(event)} className="ev-form-stack">
              <Modal.Body className="ev-editor-body">
                <div className="ev-form-stack">
                  {error && <div className="ev-error-banner">{error}</div>}

                  <ModelBasicSection
                    target={target}
                    isCreate={isCreate}
                    isCustom={isCustom}
                    supportedApis={Object.keys(compatSchemas)}
                    draft={draft}
                    dispatch={dispatch}
                  />

                  <section className="ev-editor-section">
                    <div className="ev-editor-section-title">思考档位</div>
                    <ThinkingLevelsEditor
                      value={draft.thinkingLevels}
                      onChange={(thinkingLevels) =>
                        dispatch({ type: "patch", patch: { thinkingLevels } })
                      }
                      reasoning={draft.reasoning}
                      showInheritedBadges={!isCustom}
                    />
                  </section>

                  {isCustom && (
                    <ModelBuiltinMatcher
                      providerId={target.providerId}
                      model={model}
                      modelId={draft.modelId}
                      onApplyDiffs={(diffs) =>
                        dispatch({ type: "applyCandidateDiffs", diffs, compatFields })
                      }
                    />
                  )}

                  <ModelCompatSection
                    effectiveApi={effectiveApi}
                    compatFields={compatFields}
                    draft={draft}
                    dispatch={dispatch}
                  />

                  <section className="ev-editor-section">
                    <div className="ev-editor-section-title">测试推理连接</div>
                    {!model ? (
                      <Text className="ev-inline-hint">保存模型后即可运行 smoke test。</Text>
                    ) : (
                      <div className="ev-smoke-controls">
                        <select
                          className="ev-select"
                          value={testLevel}
                          onChange={(event) =>
                            setTestLevel(event.target.value as "" | ThinkingLevel)
                          }
                        >
                          <option value="">默认 thinking</option>
                          {model.supportedThinkingLevels.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                        <label className="ev-check-row">
                          <input
                            type="checkbox"
                            className="ev-native-checkbox"
                            checked={testTools}
                            onChange={(event) => setTestTools(event.target.checked)}
                          />
                          测试工具调用
                        </label>
                        <Button
                          type="button"
                          hierarchy="secondary"
                          density="compact"
                          iconStart={<ExperimentIcon width={14} height={14} />}
                          pending={smoke?.loading === true}
                          onClick={runSmokeTest}
                        >
                          测试连接
                        </Button>
                      </div>
                    )}
                    {smoke?.error && <div className="ev-error-banner">{smoke.error}</div>}
                    {smoke?.result && <SmokeTestResult result={smoke.result} />}
                  </section>
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
                      onClick={() => void removeModel()}
                    >
                      删除模型
                    </Button>
                  )}
                  {model && !model.isCustom && model.hasOverride && (
                    <Button
                      type="button"
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      pending={deleting}
                      onClick={() => void removeModel()}
                    >
                      还原内置默认
                    </Button>
                  )}
                </div>
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary">
                      取消
                    </Button>
                  }
                />
                <Button type="submit" hierarchy="primary" pending={saving}>
                  保存
                </Button>
              </Modal.Actions>
            </form>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
