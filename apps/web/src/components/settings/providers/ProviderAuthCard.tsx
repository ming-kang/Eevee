import { DeleteIcon, KeyIcon, LogoutIcon, UndoIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Heading, Input, Link, Text } from "@earendil-works/elanor-react";
import type { ProviderDetail } from "@eevee/protocol";
import { useState } from "react";
import { api } from "../../../lib/api.ts";
import { formatTime } from "../../../lib/format.ts";
import { ConfirmModal } from "../../ConfirmModal.tsx";
import { formatAuthMeta } from "../provider-utils.ts";
import type { UseProviderOAuthResult } from "./useProviderOAuth.ts";

export function ProviderOAuthPanel({ oauth }: { readonly oauth: UseProviderOAuthResult }) {
  const { login, promptInput, setPromptInput, submitPrompt, cancelLogin } = oauth;
  if (!login) return null;

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={3} size={6}>
          OAuth 登录 · {login.providerId}
        </Heading>
        <Button hierarchy="secondary" density="compact" onClick={() => void cancelLogin()}>
          关闭
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
                授权码：<strong className="ev-mono">{ev.userCode}</strong>
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
              提交
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
            {detail.kind === "custom" ? "自定义" : "内置"}
          </span>
          {detail.kind !== "custom" && detail.hasConfigOverride && (
            <span className="eevee-badge" data-tone="warning">
              已覆盖
            </span>
          )}
          <span className="eevee-badge" data-tone={detail.configured ? "positive" : "neutral"}>
            {detail.configured ? "已配置" : "未配置"}
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
              删除自定义 Provider
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
              还原内置覆盖
            </Button>
          )}
        </div>
      </div>

      <div className="ev-auth-summary">
        <span>
          认证状态：<strong>{formatAuthMeta(detail)}</strong>
        </span>
        {detail.authExpiresAt !== undefined && (
          <span className="ev-inline-muted ev-num">
            过期时间：{formatTime(detail.authExpiresAt)}
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
            {detail.configured ? "更新 API Key" : "设置 API Key"}
          </Button>
        )}
        {detail.authMethods.oauth && (
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            onClick={() => onStartOAuth(detail.id)}
          >
            {detail.authMethods.oauthLabel ?? "OAuth 登录"}
          </Button>
        )}
        {detail.configured && (
          <Button
            type="button"
            hierarchy="tertiary"
            semantic="negative"
            density="compact"
            iconStart={<LogoutIcon width={14} height={14} />}
            onClick={() => void logout()}
          >
            清除凭据
          </Button>
        )}
      </div>

      {apiKeyOpen && (
        <div className="ev-inline-key-form">
          <Field.Root style={{ flex: 1 }}>
            <Field.Label>API Key（写入 auth.json）</Field.Label>
            <Input
              type="password"
              value={apiKeyInput}
              onValueChange={setApiKeyInput}
              placeholder="输入 API Key（或 $ENV_VAR / !cmd）"
            />
          </Field.Root>
          <Button
            type="button"
            hierarchy="primary"
            density="compact"
            pending={savingKey}
            onClick={() => void saveApiKey()}
          >
            保存
          </Button>
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          isCustom ? `删除自定义 Provider「${detail.id}」？` : `还原内置 Provider「${detail.id}」？`
        }
        description={
          isCustom
            ? `确定删除自定义 Provider「${detail.id}」及其所有配置与模型？`
            : `确定还原内置 Provider「${detail.id}」的所有 models.json 覆盖与自定义模型？`
        }
        confirmLabel={isCustom ? "确认删除" : "确认还原"}
        tone="danger"
        pending={deletingProvider}
        error={confirmError}
        onConfirm={handleDeleteOrRevertProvider}
      />
    </div>
  );
}
