import { Field, Input, Switch } from "@earendil-works/elanor-react";
import type { Dispatch } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import type { ModelEditorAction, ModelEditorDraft, ModelEditorTarget } from "./state.ts";

export type ModelBasicSectionProps = {
  readonly target: ModelEditorTarget;
  readonly isCreate: boolean;
  readonly isCustom: boolean;
  readonly supportedApis: readonly string[];
  readonly draft: ModelEditorDraft;
  readonly dispatch: Dispatch<ModelEditorAction>;
};

export function ModelBasicSection({
  target,
  isCreate,
  isCustom,
  supportedApis,
  draft,
  dispatch,
}: ModelBasicSectionProps) {
  const { t } = useI18n();
  const model = target.model;
  return (
    <section className="ev-editor-section">
      <div className="ev-editor-section-title">{t("modelEditor.basicSection")}</div>
      <div className="ev-model-form-grid">
        <Field.Root>
          <Field.Label>Model ID</Field.Label>
          <Input
            type="text"
            value={draft.modelId}
            readOnly={!isCreate}
            onValueChange={(modelId) => dispatch({ type: "patch", patch: { modelId } })}
            placeholder="vendor/model-id"
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t("modelEditor.field.displayName")}</Field.Label>
          <Input
            type="text"
            value={draft.name}
            onValueChange={(name) => dispatch({ type: "patch", patch: { name } })}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t("modelEditor.field.contextWindow")}</Field.Label>
          <Input
            type="text"
            inputMode="numeric"
            value={draft.contextWindow}
            onValueChange={(contextWindow) => dispatch({ type: "patch", patch: { contextWindow } })}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t("modelEditor.field.maxTokens")}</Field.Label>
          <Input
            type="text"
            inputMode="numeric"
            value={draft.maxTokens}
            onValueChange={(maxTokens) => dispatch({ type: "patch", patch: { maxTokens } })}
          />
        </Field.Root>
        <div className="ev-toggle-field">
          <span>{t("modelEditor.field.reasoning")}</span>
          <Switch.Root
            checked={draft.reasoning}
            onCheckedChange={(reasoning) => dispatch({ type: "patch", patch: { reasoning } })}
          >
            <Switch.Thumb />
          </Switch.Root>
        </div>
        <div className="ev-toggle-field">
          <span>{t("modelEditor.field.imageInput")}</span>
          <Switch.Root
            checked={draft.imageInput}
            onCheckedChange={(imageInput) => dispatch({ type: "patch", patch: { imageInput } })}
          >
            <Switch.Thumb />
          </Switch.Root>
        </div>
        {isCustom && (
          <>
            <Field.Root>
              <Field.Label>{t("modelEditor.field.overrideApi")}</Field.Label>
              <select
                className="ev-select"
                value={draft.apiValue}
                onChange={(event) =>
                  dispatch({
                    type: "patch",
                    patch: { apiValue: event.target.value, apiTouched: true },
                  })
                }
              >
                <option value="">
                  {target.providerApi
                    ? t("modelEditor.inheritProvider", { value: target.providerApi })
                    : t("modelEditor.selectApi")}
                </option>
                {supportedApis.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field.Root>
            <Field.Root>
              <Field.Label>{t("modelEditor.field.overrideBaseUrl")}</Field.Label>
              <Input
                type="url"
                value={draft.baseUrlValue}
                placeholder={
                  target.providerBaseUrl
                    ? t("modelEditor.inheritProvider", { value: target.providerBaseUrl })
                    : "https://api.example.com/v1"
                }
                onValueChange={(baseUrlValue) =>
                  dispatch({
                    type: "patch",
                    patch: { baseUrlValue, baseUrlTouched: true },
                  })
                }
              />
              {model?.baseUrl && (
                <Field.Description>
                  {t("modelEditor.effectiveBaseUrl", { url: model.baseUrl })}
                </Field.Description>
              )}
            </Field.Root>
          </>
        )}
      </div>
      <div className="ev-cost-grid">
        <Field.Root>
          <Field.Label>{t("modelEditor.field.costInput")}</Field.Label>
          <Input
            type="text"
            inputMode="decimal"
            value={draft.costInput}
            onValueChange={(costInput) => dispatch({ type: "patch", patch: { costInput } })}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t("modelEditor.field.costOutput")}</Field.Label>
          <Input
            type="text"
            inputMode="decimal"
            value={draft.costOutput}
            onValueChange={(costOutput) => dispatch({ type: "patch", patch: { costOutput } })}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t("modelEditor.field.costCacheRead")}</Field.Label>
          <Input
            type="text"
            inputMode="decimal"
            value={draft.costCacheRead}
            onValueChange={(costCacheRead) => dispatch({ type: "patch", patch: { costCacheRead } })}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t("modelEditor.field.costCacheWrite")}</Field.Label>
          <Input
            type="text"
            inputMode="decimal"
            value={draft.costCacheWrite}
            onValueChange={(costCacheWrite) =>
              dispatch({ type: "patch", patch: { costCacheWrite } })
            }
          />
        </Field.Root>
      </div>
    </section>
  );
}
