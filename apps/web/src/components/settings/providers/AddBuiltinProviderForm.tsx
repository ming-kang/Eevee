import { KeyIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Text } from "@earendil-works/elanor-react";
import { type BuiltinProviderCatalogItem, providerBaseUrlPlaceholder } from "@eevee/protocol";
import type { Dispatch, FormEvent } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { SearchField } from "../../SearchField.tsx";
import { BaseUrlField } from "../BaseUrlField.tsx";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { SecretRevealInput } from "../SecretRevealInput.tsx";
import type { AddProviderAction, BuiltinProviderDraft } from "./add-provider-state.ts";

export type AddBuiltinProviderFormProps = {
  readonly builtinProviders: readonly BuiltinProviderCatalogItem[];
  readonly selectedBuiltin: BuiltinProviderCatalogItem | undefined;
  readonly loadingCatalog: boolean;
  readonly saving: boolean;
  readonly draft: BuiltinProviderDraft;
  readonly dispatch: Dispatch<AddProviderAction>;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onOAuth: () => void;
};

export function AddBuiltinProviderForm({
  builtinProviders,
  selectedBuiltin,
  loadingCatalog,
  saving,
  draft,
  dispatch,
  onSubmit,
  onOAuth,
}: AddBuiltinProviderFormProps) {
  const { t } = useI18n();
  const query = draft.filter.trim().toLowerCase();
  const visibleBuiltins = query
    ? builtinProviders.filter((item) =>
        `${item.id} ${item.name} ${item.baseUrl ?? ""} ${item.apis.join(" ")}`
          .toLowerCase()
          .includes(query),
      )
    : builtinProviders;

  return (
    <div className="ev-catalog-picker">
      <div className="ev-catalog-list-pane">
        <SearchField
          size="compact"
          value={draft.filter}
          onChange={(filter) => dispatch({ type: "patchBuiltin", patch: { filter } })}
          placeholder={t("providers.builtin.searchPlaceholder")}
          clearOnEscape
        />
        <div className="ev-catalog-list">
          {loadingCatalog && builtinProviders.length === 0 ? (
            <Text className="ev-inline-hint">{t("providers.builtin.loadingCatalog")}</Text>
          ) : visibleBuiltins.length === 0 ? (
            <Text className="ev-inline-hint">{t("providers.builtin.emptyCatalog")}</Text>
          ) : (
            visibleBuiltins.map((item) => (
              <button
                type="button"
                key={item.id}
                className="ev-catalog-item"
                data-active={item.id === selectedBuiltin?.id}
                onClick={() => dispatch({ type: "selectBuiltin", id: item.id })}
              >
                <div className="ev-provider-item-head">
                  <span className="ev-dot" data-stage={item.configured ? "done" : "idle"} />
                  <strong className="ev-truncate">{item.name}</strong>
                  <span className="ev-mono ev-inline-muted">{item.id}</span>
                </div>
                <div className="ev-provider-item-badges">
                  <span className="ev-inline-muted ev-num">
                    {t("providers.modelCount", { count: item.modelCount })}
                  </span>
                  {item.configured && (
                    <span className="eevee-badge" data-tone="positive">
                      {t("providers.badge.configured")}
                    </span>
                  )}
                  {item.hasConfigOverride && (
                    <span className="eevee-badge" data-tone="warning">
                      {t("providers.badge.overridden")}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="ev-catalog-config">
        {selectedBuiltin ? (
          <form id="ev-add-builtin-form" noValidate onSubmit={onSubmit} className="ev-form-stack">
            <div className="ev-editor-section">
              <div className="ev-provider-item-head">
                <strong className="ev-catalog-selected-name">{selectedBuiltin.name}</strong>
                <span className="ev-mono ev-inline-muted">{selectedBuiltin.id}</span>
              </div>
              {selectedBuiltin.baseUrl && (
                <Text className="ev-inline-hint">
                  {t("providers.builtin.defaultEndpoint")}
                  <span className="ev-mono">{selectedBuiltin.baseUrl}</span>
                </Text>
              )}
              {selectedBuiltin.apis.length > 0 && (
                <Text className="ev-inline-hint">
                  {t("providers.builtin.apis")}
                  <span className="ev-mono">{selectedBuiltin.apis.join(", ")}</span>
                </Text>
              )}
            </div>

            <div className="ev-editor-section">
              <div className="ev-editor-section-title">{t("providers.builtin.authSection")}</div>
              {selectedBuiltin.authMethods.apiKey && (
                <Field.Root>
                  <Field.Label>API Key</Field.Label>
                  <SecretRevealInput
                    value={draft.apiKey}
                    revealed={draft.revealKey}
                    onValueChange={(apiKey) =>
                      dispatch({ type: "patchBuiltin", patch: { apiKey } })
                    }
                    onRevealedChange={(revealKey) =>
                      dispatch({ type: "patchBuiltin", patch: { revealKey } })
                    }
                    placeholder={t("providers.apiKeyInputPlaceholder")}
                  />
                </Field.Root>
              )}
              {selectedBuiltin.authMethods.oauth && (
                <div className="ev-inline-actions">
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    iconStart={<KeyIcon width={14} height={14} />}
                    pending={saving}
                    onClick={onOAuth}
                  >
                    {selectedBuiltin.authMethods.oauthLabel ?? t("providers.builtin.startOAuth")}
                  </Button>
                </div>
              )}
            </div>

            <div className="ev-editor-section">
              <div className="ev-editor-section-title">{t("providers.builtin.gatewaySection")}</div>
              <BaseUrlField
                label={t("providers.builtin.customBaseUrl")}
                baseUrl={draft.baseUrl}
                onValueChange={(baseUrl) => dispatch({ type: "patchBuiltin", patch: { baseUrl } })}
                api={selectedBuiltin.apis[0]}
                placeholder={
                  selectedBuiltin.baseUrl ?? providerBaseUrlPlaceholder(selectedBuiltin.apis[0])
                }
                previewPrefix={t("baseUrl.previewPrefix")}
                warningText={t("baseUrl.duplicateV1ShortWarning")}
              />
              <Field.Root>
                <Field.Label>{t("providers.customHeadersLabelKv")}</Field.Label>
                <HeadersEditor
                  rows={draft.headers}
                  onChange={(headers) => dispatch({ type: "patchBuiltin", patch: { headers } })}
                />
              </Field.Root>
            </div>
          </form>
        ) : (
          <Text className="ev-inline-hint">{t("providers.builtin.selectPrompt")}</Text>
        )}
      </div>
    </div>
  );
}
