import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { Field, Input, ProgressiveDisclosure } from "@earendil-works/elanor-react";
import { useI18n } from "../../../lib/i18n.ts";
import { EvDropdown } from "../../EvDropdown.tsx";
import type { OAuthClientRegistration, ServerFormState } from "./codec.ts";

export function McpOAuthFields({
  form,
  saving,
  onPatch,
}: {
  readonly form: ServerFormState;
  readonly saving: boolean;
  readonly onPatch: (patch: Partial<ServerFormState>) => void;
}) {
  const { t } = useI18n();
  return (
    <ProgressiveDisclosure.Root
      className="ev-tool-disclosure"
      open={form.oauthAdvancedOpen}
      onOpenChange={(oauthAdvancedOpen) => onPatch({ oauthAdvancedOpen })}
    >
      <ProgressiveDisclosure.Trigger className="ev-tool-disclosure-trigger">
        <ChevronRightIcon className="ev-tool-disclosure-chevron" width={14} height={14} />
        <span>{t("mcp.oauth.fieldsSummary")}</span>
      </ProgressiveDisclosure.Trigger>
      <ProgressiveDisclosure.Panel className="ev-tool-disclosure-panel">
        <div className="ev-tool-disclosure-body">
          <div className="ev-settings-grid-2">
            <Field.Root>
              <Field.Label>clientId</Field.Label>
              <Input
                type="text"
                value={form.oauthClientId}
                disabled={saving}
                onValueChange={(oauthClientId) => onPatch({ oauthClientId })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>clientSecret</Field.Label>
              <Input
                type="password"
                value={form.oauthClientSecret}
                disabled={saving}
                onValueChange={(oauthClientSecret) => onPatch({ oauthClientSecret })}
                placeholder={t("mcp.oauth.secretPlaceholder")}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>scope</Field.Label>
              <Input
                type="text"
                value={form.oauthScope}
                disabled={saving}
                onValueChange={(oauthScope) => onPatch({ oauthScope })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>clientRegistration</Field.Label>
              <EvDropdown
                ariaLabel="clientRegistration"
                disabled={saving}
                value={form.oauthClientRegistration}
                options={[
                  { value: "", label: t("mcp.oauth.registrationDefault") },
                  { value: "auto", label: "auto" },
                  { value: "dcr", label: "dcr" },
                  { value: "cimd", label: "cimd" },
                ]}
                onChange={(v) => {
                  const reg: OAuthClientRegistration =
                    v === "auto" || v === "dcr" || v === "cimd" ? v : "";
                  onPatch({ oauthClientRegistration: reg });
                }}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>callbackPort</Field.Label>
              <Input
                type="text"
                inputMode="numeric"
                value={form.oauthCallbackPort}
                disabled={saving}
                onValueChange={(oauthCallbackPort) => onPatch({ oauthCallbackPort })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>callbackUrl</Field.Label>
              <Input
                type="text"
                value={form.oauthCallbackUrl}
                disabled={saving}
                onValueChange={(oauthCallbackUrl) => onPatch({ oauthCallbackUrl })}
                placeholder="http://127.0.0.1:8080/callback"
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>clientName</Field.Label>
              <Input
                type="text"
                value={form.oauthClientName}
                disabled={saving}
                onValueChange={(oauthClientName) => onPatch({ oauthClientName })}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>authServerMetadataUrl</Field.Label>
              <Input
                type="text"
                value={form.oauthAuthServerMetadataUrl}
                disabled={saving}
                onValueChange={(oauthAuthServerMetadataUrl) =>
                  onPatch({ oauthAuthServerMetadataUrl })
                }
              />
            </Field.Root>
          </div>
        </div>
      </ProgressiveDisclosure.Panel>
    </ProgressiveDisclosure.Root>
  );
}
