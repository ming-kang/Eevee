import { DeleteIcon, KeyIcon, LogoutIcon, UndoIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Heading, Input, Link, Text } from "@earendil-works/elanor-react";
import type { ProviderDetail } from "@eevee/protocol";
import { useState } from "react";
import { api } from "../../../lib/api.ts";
import { formatTime } from "../../../lib/format.ts";
import { useI18n } from "../../../lib/i18n.ts";
import { ConfirmModal } from "../../ConfirmModal.tsx";
import { formatAuthMeta } from "../provider-utils.ts";
import type { UseProviderOAuthResult } from "./useProviderOAuth.ts";

export function ProviderOAuthPanel({ oauth }: { readonly oauth: UseProviderOAuthResult }) {
  const { t } = useI18n();
  const { login, promptInput, setPromptInput, submitPrompt, cancelLogin } = oauth;
  if (!login) return null;

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={3} size={6}>
          {t("providers.oauth.panelTitle", { providerId: login.providerId })}
        </Heading>
        <Button hierarchy="secondary" density="compact" onClick={() => void cancelLogin()}>
          {t("common.close")}
        </Button>
      </div>
      {login.authEvents.map(({ id, event: ev }) => (
        <div key={id} style={{ fontSize: "13.5px" }}>
          {ev.type === "auth_url" && (
            <div className="ev-form-stack" style={{ gap: 4 }}>
              {ev.instructions && <Text style={{ margin: 0 }}>{ev.instructions}</Text>}
              <Link href={ev.url} target="_blank" rel="noreferrer noopener">
                {ev.url}
              </Link>
            </div>
          )}
          {ev.type === "device_code" && (
            <div className="ev-form-stack" style={{ gap: 4 }}>
              <Text style={{ margin: 0 }}>
                {t("providers.oauth.deviceCodeLabel")}
                <strong className="ev-mono">{ev.userCode}</strong>
              </Text>
              <Link href={ev.verificationUri} target="_blank" rel="noreferrer noopener">
                {ev.verificationUri}
              </Link>
            </div>
          )}
          {(ev.type === "info" || ev.type === "progress") && (
            <Text style={{ margin: 0 }}>{ev.message}</Text>
          )}
        </div>
      ))}
      {login.prompt && (
        <div className="ev-form-stack" style={{ gap: 8 }}>
          <Text style={{ margin: 0, fontWeight: 500 }}>{login.prompt.message}</Text>
          {login.prompt.type === "select" ? (
            <select
              className="ev-select"
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
            >
              {login.prompt.options.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={login.prompt.type === "secret" ? "password" : "text"}
              value={promptInput}
              onValueChange={(value) => setPromptInput(value)}
              placeholder={login.prompt.placeholder}
            />
          )}
          <div>
            <Button hierarchy="primary" density="compact" onClick={() => void submitPrompt()}>
              {t("providers.oauth.submit")}
            </Button>
          </div>
        </div>
      )}
      {login.done && (
        <div>
          <span className="eevee-badge" data-tone="positive">
            {login.done}
          </span>
        </div>
      )}
      {login.error && <div className="ev-error-banner">{login.error}</div>}
    </div>
  );
}

export type ProviderAuthCardProps = {
  readonly detail: ProviderDetail;
  readonly onRefresh: (preferredId?: string) => Promise<void>;
  readonly onStartOAuth: (providerId: string) => void;
  readonly onError: (message: string | undefined) => void;
  readonly onDetailError: (message: string | undefined) => void;
};

export function ProviderAuthCard({
  detail,
  onRefresh,
  onStartOAuth,
  onError,
  onDetailError,
}: ProviderAuthCardProps) {
  const { t } = useI18n();
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);

  const saveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setSavingKey(true);
    onError(undefined);
    try {
      await api.setProviderApiKey(detail.id, { key: trimmed });
      setApiKeyOpen(false);
      setApiKeyInput("");
      await onRefresh(detail.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  const logout = async () => {
    onError(undefined);
    try {
      await api.logoutProvider(detail.id);
      await onRefresh(detail.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const isCustom = detail.kind === "custom";

  const handleDeleteOrRevertProvider = async () => {
    setDeletingProvider(true);
    setConfirmError(undefined);
    onDetailError(undefined);
    try {
      await api.deleteProvider(detail.id);
      setConfirmOpen(false);
      await onRefresh(isCustom ? undefined : detail.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConfirmError(message);
      onDetailError(message);
    } finally {
      setDeletingProvider(false);
    }
  };

  return (
    <div className="ev-settings-card">
      <div className="ev-provider-detail-head">
        <div className="ev-provider-item-head">
          <span className="ev-dot" data-stage={detail.configured ? "done" : "idle"} />
          <Heading level={3} size={5}>
            {detail.name}
          </Heading>
          <span className="ev-mono ev-inline-muted">{detail.id}</span>
          <span className="eevee-badge" data-tone={detail.kind === "custom" ? "info" : "neutral"}>
            {detail.kind === "custom" ? t("providers.badge.custom") : t("providers.badge.builtin")}
          </span>
          {detail.kind !== "custom" && detail.hasConfigOverride && (
            <span className="eevee-badge" data-tone="warning">
              {t("providers.badge.overridden")}
            </span>
          )}
          <span className="eevee-badge" data-tone={detail.configured ? "positive" : "neutral"}>
            {detail.configured
              ? t("providers.badge.configured")
              : t("providers.badge.notConfigured")}
          </span>
        </div>
        <div className="ev-inline-actions">
          {detail.kind === "custom" && (
            <Button
              type="button"
              hierarchy="tertiary"
              semantic="negative"
              density="compact"
              iconStart={<DeleteIcon width={14} height={14} />}
              pending={deletingProvider}
              onClick={() => {
                setConfirmError(undefined);
                setConfirmOpen(true);
              }}
            >
              {t("providers.auth.deleteCustom")}
            </Button>
          )}
          {detail.kind !== "custom" && detail.hasConfigOverride && (
            <Button
              type="button"
              hierarchy="tertiary"
              semantic="negative"
              density="compact"
              iconStart={<UndoIcon width={14} height={14} />}
              pending={deletingProvider}
              onClick={() => {
                setConfirmError(undefined);
                setConfirmOpen(true);
              }}
            >
              {t("providers.auth.revertBuiltin")}
            </Button>
          )}
        </div>
      </div>

      <div className="ev-auth-summary">
        <span>
          {t("providers.auth.statusLabel")}
          <strong>{formatAuthMeta(detail, t)}</strong>
        </span>
        {detail.authExpiresAt !== undefined && (
          <span className="ev-inline-muted ev-num">
            {t("providers.auth.expiresAtLabel")}
            {formatTime(detail.authExpiresAt)}
          </span>
        )}
      </div>

      <div className="ev-inline-actions">
        {detail.authMethods.apiKey && (
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<KeyIcon width={14} height={14} />}
            onClick={() => {
              setApiKeyOpen((prev) => !prev);
              setApiKeyInput("");
            }}
          >
            {detail.configured ? t("providers.auth.updateApiKey") : t("providers.auth.setApiKey")}
          </Button>
        )}
        {detail.authMethods.oauth && (
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            onClick={() => onStartOAuth(detail.id)}
          >
            {detail.authMethods.oauthLabel ?? t("providers.auth.oauthLogin")}
          </Button>
        )}
        {detail.configured && detail.authSource === "auth.json" && (
          <Button
            type="button"
            hierarchy="tertiary"
            semantic="negative"
            density="compact"
            iconStart={<LogoutIcon width={14} height={14} />}
            onClick={() => void logout()}
          >
            {t("providers.auth.clearCredentials")}
          </Button>
        )}
      </div>

      {apiKeyOpen && (
        <div className="ev-inline-key-form">
          <Field.Root style={{ flex: 1 }}>
            <Field.Label>{t("providers.auth.apiKeyAuthJsonLabel")}</Field.Label>
            <Input
              type="password"
              value={apiKeyInput}
              onValueChange={setApiKeyInput}
              placeholder={t("providers.apiKeyInputPlaceholder")}
            />
          </Field.Root>
          <Button
            type="button"
            hierarchy="primary"
            density="compact"
            pending={savingKey}
            onClick={() => void saveApiKey()}
          >
            {t("common.save")}
          </Button>
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          isCustom
            ? t("providers.auth.confirmDeleteTitle", { id: detail.id })
            : t("providers.auth.confirmRevertTitle", { id: detail.id })
        }
        description={
          isCustom
            ? t("providers.auth.confirmDeleteDesc", { id: detail.id })
            : t("providers.auth.confirmRevertDesc", { id: detail.id })
        }
        confirmLabel={
          isCustom ? t("providers.auth.confirmDeleteLabel") : t("providers.auth.confirmRevertLabel")
        }
        tone="danger"
        pending={deletingProvider}
        error={confirmError}
        onConfirm={handleDeleteOrRevertProvider}
      />
    </div>
  );
}
