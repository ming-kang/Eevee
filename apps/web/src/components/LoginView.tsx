import { Button, Card, Field, Heading, Input, Text } from "@earendil-works/elanor-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";

export type LoginViewProps = {
  readonly initialError?: string;
  readonly onAuthenticated: () => void;
};

export function LoginView({ initialError, onAuthenticated }: LoginViewProps) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t("login.emptyToken"));
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
    <div className="ev-login-page">
      <Card
        className="ev-login-card"
        style={{
          boxShadow: "var(--ev-shadow-panel)",
          borderRadius: 12,
          background: "var(--ev-surface)",
        }}
      >
        <div className="ev-form-stack" style={{ gap: 16 }}>
          <div className="ev-form-stack" style={{ gap: 6 }}>
            <Heading level={1} size={3}>
              Eevee
            </Heading>
            <Text style={{ color: "var(--ev-fg-muted)", margin: 0 }}>
              {t("login.usePrefix")} <code className="ev-mono">eevee web</code> {t("login.orPaste")}{" "}
              <code className="ev-mono">engine.token</code>
            </Text>
          </div>

          {error && <div className="ev-error-banner">{error}</div>}

          <form onSubmit={(event) => void handleSubmit(event)} className="ev-form-stack">
            <Field.Root>
              <Field.Label>Engine Token</Field.Label>
              <Input
                type="password"
                value={token}
                onValueChange={(value) => setToken(value)}
                placeholder={t("login.tokenPlaceholder")}
                autoFocus
              />
            </Field.Root>
            <Button type="submit" hierarchy="primary" pending={submitting}>
              {t("login.submit")}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
