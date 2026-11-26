import { KeyIcon, LogoutIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Card,
  Field,
  Heading,
  Input,
  Link,
  Stack,
  Text,
} from "@earendil-works/elanor-react";
import type { LoginAuthEvent, LoginPromptEvent, ProviderSummary } from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";

type IndexedAuthEvent = {
  readonly id: number;
  readonly event: LoginAuthEvent;
};

let nextAuthEventId = 1;

type ActiveLogin = {
  readonly providerId: string;
  readonly sessionId: string;
  readonly authEvents: readonly IndexedAuthEvent[];
  readonly prompt?: LoginPromptEvent;
  readonly done?: string;
  readonly error?: string;
};

export function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingProvider, setEditingProvider] = useState<string | undefined>(undefined);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const [login, setLogin] = useState<ActiveLogin | undefined>(undefined);
  const [promptInput, setPromptInput] = useState("");
  const loginAbortRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await api.listProviders();
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => loginAbortRef.current?.abort();
  }, [refresh]);

  const saveApiKey = async (providerId: string) => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setSavingKey(true);
    setError(undefined);
    try {
      await api.setProviderApiKey(providerId, { key: trimmed });
      setEditingProvider(undefined);
      setApiKeyInput("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  const logout = async (providerId: string) => {
    setError(undefined);
    try {
      await api.logoutProvider(providerId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startOAuth = async (providerId: string) => {
    loginAbortRef.current?.abort();
    const controller = new AbortController();
    loginAbortRef.current = controller;
    setError(undefined);
    try {
      const started = await api.startProviderLogin(
        providerId,
        { type: "oauth" },
        controller.signal,
      );
      setLogin({ providerId, sessionId: started.sessionId, authEvents: [] });
      setPromptInput("");
      for await (const event of api.streamLoginSession(providerId, started.sessionId, {
        signal: controller.signal,
      })) {
        if (event.type === "auth") {
          setLogin((prev) =>
            prev
              ? {
                  ...prev,
                  authEvents: [...prev.authEvents, { id: nextAuthEventId++, event: event.event }],
                }
              : prev,
          );
        } else if (event.type === "prompt") {
          setLogin((prev) => (prev ? { ...prev, prompt: event.prompt } : prev));
          setPromptInput(event.prompt.type === "select" ? (event.prompt.options[0]?.id ?? "") : "");
        } else if (event.type === "complete") {
          setLogin((prev) =>
            prev
              ? { ...prev, prompt: undefined, done: `${event.complete.providerId} 已完成登录` }
              : prev,
          );
          await refresh();
        } else if (event.type === "error") {
          setLogin((prev) =>
            prev ? { ...prev, prompt: undefined, error: event.error.message } : prev,
          );
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const submitPrompt = async () => {
    if (!login?.prompt) return;
    try {
      await api.submitLoginInput(login.providerId, login.sessionId, {
        promptId: login.prompt.promptId,
        value: promptInput,
      });
      setLogin((prev) => (prev ? { ...prev, prompt: undefined } : prev));
      setPromptInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelLogin = async () => {
    if (!login) return;
    loginAbortRef.current?.abort();
    await api.cancelLoginSession(login.providerId, login.sessionId).catch(() => undefined);
    setLogin(undefined);
  };

  return (
    <Stack direction="column" gap="medium">
      <Stack direction="row" gap="small" align="center" style={{ justifyContent: "space-between" }}>
        <Heading level={2} size={5}>
          Providers 与凭据
        </Heading>
        <Button
          hierarchy="secondary"
          density="compact"
          iconStart={<RefreshIcon width={15} height={15} />}
          pending={loading}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </Stack>

      {error && <div className="eevee-error-banner">{error}</div>}

      {login && (
        <Card>
          <Stack direction="column" gap="small">
            <Stack
              direction="row"
              gap="small"
              align="center"
              style={{ justifyContent: "space-between" }}
            >
              <Heading level={3} size={6}>
                OAuth 登录 · {login.providerId}
              </Heading>
              <Button hierarchy="secondary" density="compact" onClick={() => void cancelLogin()}>
                关闭
              </Button>
            </Stack>
            {login.authEvents.map(({ id, event: ev }) => (
              <div key={id} style={{ fontSize: "0.86rem" }}>
                {ev.type === "auth_url" && (
                  <Stack direction="column" gap="xxSmall">
                    {ev.instructions && <Text style={{ margin: 0 }}>{ev.instructions}</Text>}
                    <Link href={ev.url} target="_blank" rel="noreferrer noopener">
                      {ev.url}
                    </Link>
                  </Stack>
                )}
                {ev.type === "device_code" && (
                  <Stack direction="column" gap="xxSmall">
                    <Text style={{ margin: 0 }}>
                      授权码：<strong className="eevee-mono">{ev.userCode}</strong>
                    </Text>
                    <Link href={ev.verificationUri} target="_blank" rel="noreferrer noopener">
                      {ev.verificationUri}
                    </Link>
                  </Stack>
                )}
                {(ev.type === "info" || ev.type === "progress") && (
                  <Text style={{ margin: 0 }}>{ev.message}</Text>
                )}
              </div>
            ))}
            {login.prompt && (
              <Stack direction="column" gap="xSmall">
                <Text style={{ margin: 0, fontWeight: 500 }}>{login.prompt.message}</Text>
                {login.prompt.type === "select" ? (
                  <select
                    className="eevee-project-select"
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
                <Button hierarchy="primary" density="compact" onClick={() => void submitPrompt()}>
                  提交
                </Button>
              </Stack>
            )}
            {login.done && (
              <span className="eevee-badge" data-tone="positive">
                {login.done}
              </span>
            )}
            {login.error && <div className="eevee-error-banner">{login.error}</div>}
          </Stack>
        </Card>
      )}

      <Stack direction="column" gap="xSmall">
        {providers.map((provider) => (
          <Card key={provider.id} style={{ padding: 12 }}>
            <Stack direction="column" gap="xSmall">
              <Stack
                direction="row"
                gap="small"
                align="center"
                style={{ justifyContent: "space-between", flexWrap: "wrap" }}
              >
                <Stack direction="row" gap="xSmall" align="center">
                  <strong>{provider.name}</strong>
                  <span
                    className="eevee-mono"
                    style={{ fontSize: "0.78rem", color: "var(--semantic-color-text-secondary)" }}
                  >
                    {provider.id} · {provider.modelCount} 模型
                  </span>
                  <span
                    className="eevee-badge"
                    data-tone={provider.configured ? "positive" : "neutral"}
                  >
                    {provider.configured
                      ? `已配置 (${provider.authType ?? provider.authSource ?? "auth"})`
                      : "未配置"}
                  </span>
                </Stack>
                <Stack direction="row" gap="xSmall">
                  {provider.authMethods.apiKey && (
                    <Button
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<KeyIcon width={14} height={14} />}
                      onClick={() => {
                        setEditingProvider(
                          editingProvider === provider.id ? undefined : provider.id,
                        );
                        setApiKeyInput("");
                      }}
                    >
                      设置 Key
                    </Button>
                  )}
                  {provider.authMethods.oauth && (
                    <Button
                      hierarchy="secondary"
                      density="compact"
                      onClick={() => void startOAuth(provider.id)}
                    >
                      {provider.authMethods.oauthLabel ?? "OAuth 登录"}
                    </Button>
                  )}
                  {provider.configured && (
                    <Button
                      hierarchy="tertiary"
                      semantic="negative"
                      density="compact"
                      iconStart={<LogoutIcon width={14} height={14} />}
                      onClick={() => void logout(provider.id)}
                    >
                      清除
                    </Button>
                  )}
                </Stack>
              </Stack>

              {editingProvider === provider.id && (
                <Stack direction="row" gap="xSmall" align="end">
                  <Field.Root style={{ flex: 1 }}>
                    <Field.Label>API Key</Field.Label>
                    <Input
                      type="password"
                      value={apiKeyInput}
                      onValueChange={(value) => setApiKeyInput(value)}
                      placeholder="输入 API Key（或 $ENV_VAR）"
                    />
                  </Field.Root>
                  <Button
                    hierarchy="primary"
                    density="compact"
                    pending={savingKey}
                    onClick={() => void saveApiKey(provider.id)}
                  >
                    保存
                  </Button>
                </Stack>
              )}
            </Stack>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}
