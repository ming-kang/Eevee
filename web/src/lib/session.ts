import { ApiRequestError, type Client, createClient } from "../../../src/api/client.ts";
import type { EngineStatus } from "../../../src/api/contract.ts";
import { errorText } from "./errors.ts";
import { t } from "./i18n.ts";
import { extractAuthCode } from "./router.ts";

const STORAGE_KEY = "eevee.token";

export class Unauthorized extends Error {
  override name = "Unauthorized";
}

export type SessionInfo = {
  client: Client;
  token: string;
  status: EngineStatus;
};

type TokenStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type SessionEnv = {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  clearHash: () => void;
  storage: TokenStorage;
  createClient?: typeof createClient;
};

export async function openSessionWith(env: SessionEnv): Promise<SessionInfo> {
  const makeClient = env.createClient ?? createClient;
  const code = extractAuthCode(env.hash);
  if (code !== undefined) {
    env.clearHash();
    try {
      const { token } = await makeClient({ baseUrl: env.origin }).call("POST /api/session", {
        code,
      });
      env.storage.setItem(STORAGE_KEY, token);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        throw new Unauthorized(errorText(error));
      }
      throw error;
    }
  }
  const token = env.storage.getItem(STORAGE_KEY);
  if (!token) throw new Unauthorized(t("Not signed in yet"));
  const client = makeClient({ baseUrl: env.origin, token });
  try {
    const status = await client.call("GET /api/status");
    return { client, token, status };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      env.storage.removeItem(STORAGE_KEY);
      throw new Unauthorized(t("The sign-in is no longer valid"));
    }
    throw error;
  }
}

type BrowserGlobals = {
  location: { origin: string; pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  localStorage: TokenStorage;
};

function browserEnv(): SessionEnv {
  const g = globalThis as unknown as BrowserGlobals;
  return {
    origin: g.location.origin,
    pathname: g.location.pathname,
    search: g.location.search,
    hash: g.location.hash,
    clearHash: () => {
      g.history.replaceState(null, "", g.location.pathname + g.location.search);
    },
    storage: g.localStorage,
  };
}

export function openSession(): Promise<SessionInfo> {
  return openSessionWith(browserEnv());
}
