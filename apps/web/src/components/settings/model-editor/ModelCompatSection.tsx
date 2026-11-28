import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Field,
  Input,
  ProgressiveDisclosure,
  SegmentedControl,
  TextArea,
} from "@earendil-works/elanor-react";
import type { CompatFieldInfo } from "@eevee/protocol";
import { type Dispatch, useMemo, useState } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { EvDropdown } from "../../EvDropdown.tsx";
import { EvTooltip } from "../../EvTooltip.tsx";
import { SearchField } from "../../SearchField.tsx";
import {
  ADVANCED_KEYS,
  filterCompatFields,
  isCompatFieldConfigured,
  type ModelEditorAction,
  type ModelEditorDraft,
  serializeCompatField,
} from "./state.ts";

export type ModelCompatSectionProps = {
  readonly compatFields: readonly CompatFieldInfo[];
  readonly draft: ModelEditorDraft;
  readonly dispatch: Dispatch<ModelEditorAction>;
};

function CompatFieldRow({
  field,
  draft,
  dispatch,
}: {
  readonly field: CompatFieldInfo;
  readonly draft: ModelEditorDraft;
  readonly dispatch: Dispatch<ModelEditorAction>;
}) {
  const { t } = useI18n();
  const value = draft.compatValues[field.key];
  const text = draft.compatText[field.key] ?? serializeCompatField(field, value);
  const configured = isCompatFieldConfigured(field, draft);
  const isWide = field.kind === "stringMap" || field.kind === "json";

  return (
    <div className="ev-compat-row" data-configured={configured} data-wide={isWide}>
      <div className="ev-compat-row-main">
        <EvTooltip content={field.note} side="top" align="start" disabled={!field.note}>
          <div className="ev-compat-info">
            <div className="ev-compat-key-line">
              <span className="ev-mono ev-compat-key">{field.key}</span>
              {configured && <span className="ev-compat-dot" aria-hidden="true" />}
            </div>
            {field.note && <span className="ev-compat-note ev-truncate">{field.note}</span>}
          </div>
        </EvTooltip>

        {!isWide && (
          <div className="ev-compat-control">
            {field.kind === "boolean" && (
              <SegmentedControl.Root
                density="compact"
                className="ev-compat-tristate"
                aria-label={field.key}
                value={[value === true ? "true" : value === false ? "false" : "default"]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === "true") {
                    dispatch({ type: "setCompatBoolean", key: field.key, enabled: true });
                  } else if (next === "false") {
                    dispatch({ type: "setCompatBoolean", key: field.key, enabled: false });
                  } else if (next === "default") {
                    dispatch({ type: "setCompatBoolean", key: field.key, enabled: undefined });
                  }
                }}
              >
                <SegmentedControl.Item value="default">
                  {t("modelEditor.compat.protocolDefault")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="true">
                  {t("modelEditor.compat.on")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="false">
                  {t("modelEditor.compat.off")}
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            )}
            {field.kind === "enum" && (
              <EvDropdown
                density="compact"
                className="ev-compat-select"
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
                className="ev-compat-number"
                type="text"
                inputMode="decimal"
                aria-label={field.key}
                value={text}
                placeholder={t("modelEditor.compat.protocolDefault")}
                onValueChange={(next) =>
                  dispatch({ type: "setCompatText", key: field.key, value: next })
                }
              />
            )}
          </div>
        )}
      </div>

      {isWide && (
        <TextArea
          rows={field.kind === "json" ? 3 : 2}
          monospace={field.kind === "json"}
          aria-label={field.key}
          value={text}
          placeholder={
            field.kind === "stringMap"
              ? t("modelEditor.compat.kvPlaceholder")
              : t("modelEditor.compat.jsonPlaceholder")
          }
          onValueChange={(next) => dispatch({ type: "setCompatText", key: field.key, value: next })}
        />
      )}
    </div>
  );
}

export function ModelCompatSection({ compatFields, draft, dispatch }: ModelCompatSectionProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const configuredCount = useMemo(
    () => compatFields.filter((field) => isCompatFieldConfigured(field, draft)).length,
    [compatFields, draft],
  );

  const summaryFields = useMemo(
    () =>
      compatFields.filter(
        (field) => isCompatFieldConfigured(field, draft) || draft.compatTouched[field.key] === true,
      ),
    [compatFields, draft],
  );

  const filteredFields = useMemo(
    () => filterCompatFields(compatFields, query, onlyConfigured, draft),
    [compatFields, query, onlyConfigured, draft],
  );

  const advancedCount = ADVANCED_KEYS.filter(
    (key) => draft.advancedText[key].trim().length > 0,
  ).length;

  const displayedFields = expanded ? filteredFields : summaryFields;

  return (
    <section className="ev-editor-section">
      <div className="ev-editor-section-head">
        <div className="ev-compat-head-title">
          <div className="ev-editor-section-title">{t("modelEditor.compat.title")}</div>
          {compatFields.length > 0 && (
            <span className="eevee-badge" data-tone={configuredCount > 0 ? "info" : "muted"}>
              {configuredCount > 0
                ? t("modelEditor.compat.configuredCount", { count: configuredCount })
                : t("modelEditor.compat.allDefault")}
            </span>
          )}
        </div>
        {compatFields.length > 0 && (
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded
              ? t("modelEditor.compat.collapse")
              : t("modelEditor.compat.expandAll", { count: compatFields.length })}
          </Button>
        )}
      </div>

      {compatFields.length > 0 && expanded && (
        <div className="ev-compat-toolbar">
          <SearchField
            size="compact"
            clearOnEscape
            className="ev-compat-search"
            value={query}
            onChange={setQuery}
            placeholder={t("modelEditor.compat.filterPlaceholder")}
            ariaLabel={t("modelEditor.compat.filterPlaceholder")}
          />
          {(configuredCount > 0 || onlyConfigured) && (
            <SegmentedControl.Root
              density="compact"
              value={[onlyConfigured ? "configured" : "all"]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "all") setOnlyConfigured(false);
                else if (next === "configured") setOnlyConfigured(true);
              }}
            >
              <SegmentedControl.Item value="all">
                {t("modelEditor.compat.filterAll", { count: compatFields.length })}
              </SegmentedControl.Item>
              <SegmentedControl.Item value="configured">
                {t("modelEditor.compat.filterConfigured", { count: configuredCount })}
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          )}
        </div>
      )}

      {compatFields.length > 0 && (displayedFields.length > 0 || expanded) && (
        <div className="ev-compat-list">
          {displayedFields.length > 0 ? (
            displayedFields.map((field) => (
              <CompatFieldRow key={field.key} field={field} draft={draft} dispatch={dispatch} />
            ))
          ) : (
            <div className="ev-compat-empty">{t("modelEditor.compat.emptyMatch")}</div>
          )}
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
          {advancedCount > 0 && (
            <span className="eevee-badge" data-tone="info">
              {t("modelEditor.compat.configuredCount", { count: advancedCount })}
            </span>
          )}
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
