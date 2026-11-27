import { Button, Field, Heading, Input } from "@earendil-works/elanor-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { BrandLogo } from "./BrandLogo.tsx";

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
      <div className="ev-login-card">
        <div className="ev-login-brand">
          <div className="ev-landing-logo">
            <BrandLogo size={24} />
          </div>
          <Heading level={1} size={4} className="ev-login-title">
            Eevee
          </Heading>
        </div>

        {error && (
          <div className="ev-error-banner" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} className="ev-form-stack">
          <Field.Root>
            <Field.Label>{t("login.tokenLabel")}</Field.Label>
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
    </div>
  );
}
