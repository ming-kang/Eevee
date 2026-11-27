import { CloudDownloadIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Input, Switch, Text } from "@earendil-works/elanor-react";
import { providerBaseUrlPlaceholder } from "@eevee/protocol";
import type { Dispatch, FormEvent } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { BaseUrlField, BaseUrlPreview } from "../BaseUrlField.tsx";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { ModelProbeSelector } from "../ModelProbeSelector.tsx";
import { SecretRevealInput } from "../SecretRevealInput.tsx";
import type {
  AddProviderAction,
  CustomProviderDraft,
  ProbeModelsDraft,
} from "./add-provider-state.ts";

export type AddCustomProviderFormProps = {
  readonly supportedApis: readonly string[];
  readonly draft: CustomProviderDraft;
  readonly probe: ProbeModelsDraft;
  readonly dispatch: Dispatch<AddProviderAction>;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onProbe: () => void;
};

export function AddCustomProviderForm({
  supportedApis,
  draft,
  probe,
  dispatch,
  onSubmit,
  onProbe,
}: AddCustomProviderFormProps) {
  const { t } = useI18n();
  const apiOptions = supportedApis.length > 0 ? supportedApis : [draft.api];

  return (
    <form id="ev-add-custom-form" onSubmit={onSubmit} className="ev-form-stack">
      <section className="ev-editor-section">
        <div className="ev-editor-section-title">{t("providers.custom.basicSection")}</div>
        <div className="ev-model-form-grid">
          <Field.Root>
            <Field.Label>Provider ID</Field.Label>
            <Input
              type="text"
              value={draft.id}
              onValueChange={(id) => dispatch({ type: "patchCustom", patch: { id } })}
              placeholder="my-openai-proxy"
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>{t("providers.custom.nameLabel")}</Field.Label>
            <Input
              type="text"
              value={draft.name}
              onValueChange={(name) => dispatch({ type: "patchCustom", patch: { name } })}
              placeholder={t("providers.custom.namePlaceholder")}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>{t("providers.field.api")}</Field.Label>
            <select
              className="ev-select"
              value={draft.api}
              onChange={(event) =>
                dispatch({ type: "patchCustom", patch: { api: event.target.value } })
              }
            >
              {apiOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field.Root>
          <BaseUrlField
            label="Base URL"
            baseUrl={draft.baseUrl}
            onValueChange={(baseUrl) => dispatch({ type: "patchCustom", patch: { baseUrl } })}
            api={draft.api}
            placeholder={providerBaseUrlPlaceholder(draft.api)}
            hidePreview
          />
        </div>
        <BaseUrlPreview
          api={draft.api}
          baseUrl={draft.baseUrl}
          previewPrefix={t("baseUrl.effectivePreviewPrefix")}
          warningText={t("baseUrl.duplicateV1Warning")}
        />
      </section>

      <section className="ev-editor-section">
        <div className="ev-editor-section-title">{t("providers.custom.authSection")}</div>
        <Field.Root>
          <Field.Label>{t("providers.custom.apiKeyLabel")}</Field.Label>
          <SecretRevealInput
            value={draft.apiKey}
            revealed={draft.revealKey}
            onValueChange={(apiKey) => dispatch({ type: "patchCustom", patch: { apiKey } })}
            onRevealedChange={(revealKey) =>
              dispatch({ type: "patchCustom", patch: { revealKey } })
            }
            placeholder={t("providers.custom.apiKeyPlaceholder")}
          />
        </Field.Root>
        <div className="ev-toggle-field">
          <span>{t("providers.custom.authHeaderLabel")}</span>
          <Switch.Root
            checked={draft.authHeader}
            onCheckedChange={(authHeader) =>
              dispatch({ type: "patchCustom", patch: { authHeader } })
            }
          >
            <Switch.Thumb />
          </Switch.Root>
        </div>
        <Field.Root>
          <Field.Label>{t("providers.customHeadersLabelKv")}</Field.Label>
          <HeadersEditor
            rows={draft.headers}
            onChange={(headers) => dispatch({ type: "patchCustom", patch: { headers } })}
          />
        </Field.Root>
      </section>

      <section className="ev-editor-section">
        <div className="ev-editor-section-head">
          <div className="ev-editor-section-title">{t("providers.custom.probeSection")}</div>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<CloudDownloadIcon width={14} height={14} />}
            pending={probe.probing}
            onClick={onProbe}
          >
            {t("providers.custom.probeButton")}
          </Button>
        </div>
        {probe.catalogUrl && (
          <Text className="ev-inline-hint">
            {t("probe.catalogUrlLabel")}
            <span className="ev-mono">{probe.catalogUrl}</span>
          </Text>
        )}
        {probe.error && <div className="ev-error-banner">{probe.error}</div>}
        {probe.truncated && (
          <div>
            <span className="eevee-badge" data-tone="warning">
              {t("providers.custom.probeTruncated")}
            </span>
          </div>
        )}
        {probe.models.length > 0 && (
          <ModelProbeSelector
            models={probe.models}
            selected={probe.selected}
            onSelectedChange={(selected) => dispatch({ type: "patchProbe", patch: { selected } })}
            filter={probe.filter}
            onFilterChange={(filter) => dispatch({ type: "patchProbe", patch: { filter } })}
            filterPlaceholder={t("providers.custom.probeFilterPlaceholder")}
            variant="list"
          />
        )}
      </section>
    </form>
  );
}
