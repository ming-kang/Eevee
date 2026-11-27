import { Button, Field, Heading, Input, Switch } from "@earendil-works/elanor-react";
import { type ProviderDetail, providerBaseUrlPlaceholder } from "@eevee/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { useI18n } from "../../../lib/i18n.ts";
import { showToast } from "../../../lib/toasts.ts";
import { BaseUrlField } from "../BaseUrlField.tsx";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { SecretRevealInput } from "../SecretRevealInput.tsx";
import {
  buildProviderPatch,
  createProviderConfigDraft,
  type ProviderConfigDraft,
} from "./provider-config.ts";

export { buildProviderPatch, createProviderConfigDraft, type ProviderConfigDraft };

export type ProviderConfigFormProps = {
  readonly detail: ProviderDetail;
  readonly supportedApis: readonly string[];
  readonly onSaved: (provider: ProviderDetail) => Promise<void>;
  readonly onDetailError: (message: string | undefined) => void;
};

export function ProviderConfigForm({
  detail,
  supportedApis,
  onSaved,
  onDetailError,
}: ProviderConfigFormProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ProviderConfigDraft>(() => createProviderConfigDraft(detail));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setDraft(createProviderConfigDraft(detail));
    setSaveError(undefined);
  }, [detail]);

  const patchDraft = (patch: Partial<ProviderConfigDraft>, resetError = true) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    if (resetError) {
      setSaveError(undefined);
    }
  };

  const apiOptions = Array.from(
    new Set([
      ...supportedApis,
      ...(draft.api ? [draft.api] : []),
      ...(detail.api ? [detail.api] : []),
    ]),
  );

  const effectiveConfigApi =
    draft.api.trim() || detail.config?.api || detail.api || detail.models[0]?.api;
  const effectiveBaseUrl = draft.baseUrl.trim() || detail.baseUrl;
  const fallbackNote =
    !draft.baseUrl.trim() && !draft.api.trim() ? detail.connectionNote : undefined;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    onDetailError(undefined);
    setSaveError(undefined);
    try {
      const patch = buildProviderPatch(detail, draft);
      if (Object.keys(patch).length > 0) {
        const res = await api.updateProvider(detail.id, patch);
        await onSaved(res.provider);
      }
      showToast(t("common.saved"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={3} size={6}>
          {t("providers.config.title")}
        </Heading>
      </div>
      <form noValidate onSubmit={(event) => void handleSave(event)} className="ev-form-stack">
        <div className="ev-model-form-grid">
          <Field.Root>
            <Field.Label>{t("providers.config.displayName")}</Field.Label>
            <Input
              type="text"
              value={draft.name}
              onValueChange={(name) => patchDraft({ name })}
              placeholder={detail.name}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>{t("providers.field.api")}</Field.Label>
            <select
              className="ev-select"
              value={draft.api}
              onChange={(event) => patchDraft({ api: event.target.value })}
            >
              <option value="">
                {detail.kind === "custom"
                  ? t("providers.config.apiPerModel")
                  : t("providers.config.apiInheritBuiltin")}
              </option>
              {apiOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field.Root>
        </div>

        <BaseUrlField
          label="Base URL"
          baseUrl={draft.baseUrl}
          onValueChange={(baseUrl) => patchDraft({ baseUrl })}
          api={effectiveConfigApi}
          placeholder={detail.baseUrl ?? providerBaseUrlPlaceholder(effectiveConfigApi)}
          previewBaseUrl={effectiveBaseUrl}
          fallbackNote={fallbackNote}
          previewPrefix={t("baseUrl.effectiveUrlPrefix")}
          warningText={t("baseUrl.duplicateV1Warning")}
        />

        <Field.Root>
          <Field.Label>{t("providers.config.apiKeyLabel")}</Field.Label>
          <SecretRevealInput
            value={draft.apiKey}
            disabled={draft.clearApiKey}
            revealed={draft.revealApiKey}
            onValueChange={(apiKey) =>
              patchDraft({
                apiKey,
                apiKeyTouched: true,
                clearApiKey: false,
              })
            }
            onRevealedChange={(revealApiKey) => patchDraft({ revealApiKey }, false)}
            placeholder={
              detail.config?.hasApiKey && !detail.config?.apiKeyRef
                ? t("providers.config.apiKeySetPlaceholder")
                : t("providers.config.apiKeyFallbackPlaceholder")
            }
            extraActions={
              detail.config?.hasApiKey ? (
                <Button
                  type="button"
                  hierarchy={draft.clearApiKey ? "primary" : "secondary"}
                  density="compact"
                  onClick={() =>
                    patchDraft({
                      clearApiKey: !draft.clearApiKey,
                      apiKey: "",
                      apiKeyTouched: true,
                    })
                  }
                >
                  {draft.clearApiKey
                    ? t("providers.config.apiKeyMarkedClear")
                    : t("providers.config.clearApiKey")}
                </Button>
              ) : undefined
            }
          />
        </Field.Root>

        <div className="ev-toggle-field">
          <span>{t("providers.config.authHeaderLabel")}</span>
          <Switch.Root
            checked={draft.authHeader}
            onCheckedChange={(authHeader) => patchDraft({ authHeader })}
          >
            <Switch.Thumb />
          </Switch.Root>
        </div>

        <Field.Root>
          <Field.Label>{t("providers.customHeadersLabelKv")}</Field.Label>
          <HeadersEditor rows={draft.headers} onChange={(headers) => patchDraft({ headers })} />
        </Field.Root>

        {saveError && <div className="ev-error-banner">{saveError}</div>}

        <div className="ev-inline-actions">
          <Button type="submit" hierarchy="primary" density="compact" pending={saving}>
            {t("providers.config.saveButton")}
          </Button>
        </div>
      </form>
    </div>
  );
}
