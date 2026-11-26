import { Button, Card, Field, Heading, Input, Stack, Text } from "@earendil-works/elanor-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";

export type LoginViewProps = {
  readonly initialError?: string;
  readonly onAuthenticated: () => void;
};

export function LoginView({ initialError, onAuthenticated }: LoginViewProps) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("请输入本机 Engine Token。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await api.createWebSession({ token: trimmed });
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="eevee-login-page">
      <Card className="eevee-login-card">
        <Stack direction="column" gap="medium">
          <Stack direction="column" gap="xSmall">
            <Heading level={1} size={3}>
              Eevee
            </Heading>
            <Text style={{ color: "var(--semantic-color-text-secondary)", margin: 0 }}>
              运行 <code className="eevee-mono">eevee web</code> 获取一次性免密链接，或粘贴本机{" "}
              <code className="eevee-mono">engine.token</code> 登录。
            </Text>
          </Stack>

          {error && <div className="eevee-error-banner">{error}</div>}

          <form onSubmit={(event) => void handleSubmit(event)}>
            <Stack direction="column" gap="small">
              <Field.Root>
                <Field.Label>Engine Token</Field.Label>
                <Input
                  type="password"
                  value={token}
                  onValueChange={(value) => setToken(value)}
                  placeholder="粘贴 engine.token 内容"
                  autoFocus
                />
              </Field.Root>
              <Button type="submit" hierarchy="primary" pending={submitting}>
                登录
              </Button>
            </Stack>
          </form>
        </Stack>
      </Card>
    </div>
  );
}
