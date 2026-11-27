import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { Field, Input } from "@earendil-works/elanor-react";
import { useI18n } from "../../../lib/i18n.ts";
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
    <details
      className="ev-tool-disclosure"
      open={form.oauthAdvancedOpen}
      onToggle={(event) => onPatch({ oauthAdvancedOpen: event.currentTarget.open })}
    >
      <summary>
        <ChevronRightIcon className="ev-tool-disclosure-chevron" width={14} height={14} />
        <span>{t("mcp.oauth.fieldsSummary")}</span>
      </summary>
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
            <select
              className="ev-select"
              disabled={saving}
              value={form.oauthClientRegistration}
              onChange={(event) => {
                const v = event.target.value;
                const reg: OAuthClientRegistration =
                  v === "auto" || v === "dcr" || v === "cimd" ? v : "";
                onPatch({ oauthClientRegistration: reg });
              }}
            >
              <option value="">{t("mcp.oauth.registrationDefault")}</option>
              <option value="auto">auto</option>
              <option value="dcr">dcr</option>
              <option value="cimd">cimd</option>
            </select>
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
    </details>
  );
}
