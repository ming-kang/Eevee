import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import {
  Field,
  Input,
  ProgressiveDisclosure,
  Switch,
  TextArea,
} from "@earendil-works/elanor-react";
import type { CompatFieldInfo } from "@eevee/protocol";
import { type Dispatch, useState } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { EvDropdown } from "../../EvDropdown.tsx";
import {
  ADVANCED_KEYS,
  type ModelEditorAction,
  type ModelEditorDraft,
  serializeCompatField,
} from "./state.ts";

export type ModelCompatSectionProps = {
  readonly compatFields: readonly CompatFieldInfo[];
  readonly draft: ModelEditorDraft;
  readonly dispatch: Dispatch<ModelEditorAction>;
};

export function ModelCompatSection({ compatFields, draft, dispatch }: ModelCompatSectionProps) {
  const { t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <section className="ev-editor-section">
      <div className="ev-editor-section-title">{t("modelEditor.compat.title")}</div>
      {compatFields.length > 0 && (
        <div className="ev-compat-grid">
          {compatFields.map((field) => {
            const value = draft.compatValues[field.key];
            const text = draft.compatText[field.key] ?? serializeCompatField(field, value);
            return (
              <div key={field.key} className="ev-compat-field">
                <div className="ev-compat-label">
                  <span className="ev-mono">{field.key}</span>
                  {field.note && <span className="ev-compat-note">{field.note}</span>}
                </div>
                {field.kind === "boolean" && (
                  <div className="ev-thinking-toggle">
                    <Switch.Root
                      checked={value === true}
                      onCheckedChange={(enabled) =>
                        dispatch({ type: "setCompatBoolean", key: field.key, enabled })
                      }
                    >
                      <Switch.Thumb />
                    </Switch.Root>
                    <span>
                      {value === true ? t("modelEditor.compat.on") : t("modelEditor.compat.off")}
                    </span>
                  </div>
                )}
                {field.kind === "enum" && (
                  <EvDropdown
                    ariaLabel={field.key}
                    value={typeof value === "string" ? value : ""}
                    options={[
                      { value: "", label: t("modelEditor.compat.protocolDefault") },
                      ...(field.options ?? []).map((option) => ({ value: option, label: option })),
                    ]}
                    onChange={(nextValue) =>
                      dispatch({
                        type: "setCompatEnum",
                        key: field.key,
                        value: nextValue,
                      })
                    }
                  />
                )}
                {field.kind === "number" && (
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={text}
                    placeholder={t("modelEditor.compat.protocolDefault")}
                    onValueChange={(next) =>
                      dispatch({ type: "setCompatText", key: field.key, value: next })
                    }
                  />
                )}
                {(field.kind === "stringMap" || field.kind === "json") && (
                  <TextArea
                    rows={field.kind === "json" ? 4 : 3}
                    monospace={field.kind === "json"}
                    value={text}
                    placeholder={
                      field.kind === "stringMap"
                        ? t("modelEditor.compat.kvPlaceholder")
                        : t("modelEditor.compat.jsonPlaceholder")
                    }
                    onValueChange={(next) =>
                      dispatch({ type: "setCompatText", key: field.key, value: next })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <ProgressiveDisclosure.Root
        className="ev-tool-disclosure"
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        <ProgressiveDisclosure.Trigger className="ev-tool-disclosure-trigger">
          <ChevronRightIcon className="ev-tool-disclosure-chevron" width={14} height={14} />
          <span>{t("modelEditor.compat.advancedJson")}</span>
        </ProgressiveDisclosure.Trigger>
        <ProgressiveDisclosure.Panel className="ev-tool-disclosure-panel">
          <div className="ev-tool-disclosure-body">
            {ADVANCED_KEYS.map((key) => (
              <Field.Root key={key}>
                <Field.Label>
                  <span className="ev-mono">{key}</span>
                </Field.Label>
                <TextArea
                  monospace
                  rows={key === "headers" ? 3 : 5}
                  value={draft.advancedText[key]}
                  placeholder={t("modelEditor.compat.leaveBlank")}
                  onValueChange={(value) => dispatch({ type: "setAdvancedText", key, value })}
                />
              </Field.Root>
            ))}
          </div>
        </ProgressiveDisclosure.Panel>
      </ProgressiveDisclosure.Root>
    </section>
  );
}
