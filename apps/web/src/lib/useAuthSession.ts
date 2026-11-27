import type { WebSessionResponse } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api, consumeTicketFromHash } from "./api.ts";

export type AuthSessionState =
  | { readonly kind: "loading" }
  | { readonly kind: "login" }
  | { readonly kind: "authenticated" }
  | { readonly kind: "error"; readonly error: string };

export type AuthSession = {
  readonly auth: AuthSessionState;
  readonly login: (token?: string) => Promise<void>;
  readonly logout: () => Promise<void>;
};

let inflightTicket:
  | { readonly ticket: string; readonly promise: Promise<WebSessionResponse> }
  | undefined;

function consumeTicketFromQuery(): string | undefined {
  const search = window.location.search;
  if (!search || search.length <= 1) return undefined;
  const params = new URLSearchParams(search);
  const ticket = params.get("ticket")?.trim();
  if (!ticket) return undefined;
  params.delete("ticket");
  const rest = params.toString();
  const nextUrl = `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
  return ticket;
}

// Reuse an in-flight one-time ticket redemption across React StrictMode remounts.
function redeemOneTimeTicket(): Promise<WebSessionResponse> | undefined {
  const ticket = consumeTicketFromHash() ?? consumeTicketFromQuery();
  if (ticket) {
    const promise = api.createWebSession({ ticket }).finally(() => {
      if (inflightTicket?.ticket === ticket) inflightTicket = undefined;
    });
    inflightTicket = { ticket, promise };
    return promise;
  }
  return inflightTicket?.promise;
}

export function useAuthSession(): AuthSession {
  const [auth, setAuth] = useState<AuthSessionState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    const initAuth = async () => {
      const ticketRedemption = redeemOneTimeTicket();
      if (ticketRedemption) {
        try {
          await ticketRedemption;
          if (active) setAuth({ kind: "authenticated" });
        } catch (err) {
          if (active) {
            setAuth({
              kind: "error",
              error: `登录链接已失效或已使用：${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        return;
      }

      try {
        const session = await api.getWebSession();
        if (active) {
          setAuth(session.authenticated ? { kind: "authenticated" } : { kind: "login" });
        }
      } catch (err) {
        if (active) {
          setAuth({
            kind: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    void initAuth();
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (token?: string) => {
    if (token !== undefined) {
      await api.createWebSession({ token });
    }
    setAuth({ kind: "authenticated" });
  }, []);

  const logout = useCallback(async () => {
    await api.logoutWebSession().catch(() => undefined);
    setAuth({ kind: "login" });
  }, []);

  return { auth, login, logout };
}
