import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { type McpOAuthConfig, mcpNamespace } from "@earendil-works/pi-mcp";
import {
  completeMcpSignIn,
  createMcpAuthProvider,
  listenForLoopbackSignIn,
  type McpAuthorizationResponse,
  type McpAuthProvider,
  McpOAuthAuthorizationRequiredError,
  type McpOAuthServerStore,
  type McpOAuthSettings,
  type McpOAuthState,
  McpRefreshLockBusyError,
  McpSignInCancelledError,
  type McpSignInRedirect,
  type OAuthChallenge,
  responseFromRedirectUrl,
  startMcpSignIn,
  waitForLoopbackSignIn,
} from "@earendil-works/pi-mcp/oauth";
import { resolveConfigValue } from "../../shared/config-value.ts";
import { withFileLock } from "../../shared/file-lock.ts";
import { errorMessage, isRecord } from "../../shared/guards.ts";
import { LockedJsonMapStore } from "../../shared/json-map-store.ts";

export {
  McpOAuthAuthorizationRequiredError,
  McpRefreshLockBusyError,
  McpSignInCancelledError,
  type OAuthChallenge,
};

export const MCP_AUTH_FILE = "mcp-auth.json";

const DEFAULT_REDIRECT_URL = "http://127.0.0.1/callback";

export type McpOAuthTokenSummary = {
  readonly hasTokens: boolean;
  readonly expiresAt?: number;
};

export type McpOAuthCredentialStoreOptions = {
  readonly refreshLockTimeoutMs?: number;
};

export function mcpOAuthStoreKey(name: string, serverUrl: string): string {
  return `${mcpNamespace(name)}|${new URL(serverUrl).href}`;
}

function isLockTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.startsWith("Timed out waiting for file lock:")
  );
}

function validateOAuthEntry(key: string, entry: unknown): McpOAuthState {
  if (!isRecord(entry) || typeof entry.serverUrl !== "string") {
    throw new Error(`Invalid ${MCP_AUTH_FILE} entry "${key}"`);
  }
  return { ...entry, serverUrl: entry.serverUrl } as McpOAuthState;
}

export class McpOAuthCredentialStore {
  readonly filePath: string;
  private readonly store: LockedJsonMapStore<McpOAuthState>;
  private readonly refreshLockTimeoutMs?: number;
  private readonly activeRefreshes = new Map<string, Promise<void>>();

  constructor(dir: string, options: McpOAuthCredentialStoreOptions = {}) {
    this.filePath = join(dir, MCP_AUTH_FILE);
    this.store = new LockedJsonMapStore({
      filePath: this.filePath,
      validateEntry: validateOAuthEntry,
      formatParseError: (error) =>
        new Error(`Failed to parse ${MCP_AUTH_FILE}: ${errorMessage(error)}`),
      invalidRootMessage: `Invalid ${MCP_AUTH_FILE}: expected an object keyed by server`,
    });
    this.refreshLockTimeoutMs = options.refreshLockTimeoutMs;
  }

  forServer(name: string, serverUrl: string): McpOAuthServerStore {
    const key = mcpOAuthStoreKey(name, serverUrl);
    const lockHash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const refreshLockPath = join(dirname(this.filePath), `.mcp-refresh-${lockHash}`);
    return {
      load: async (): Promise<McpOAuthState | undefined> => {
        const state = await this.store.get(key);
        return state === undefined ? undefined : structuredClone(state);
      },
      save: async (state: McpOAuthState): Promise<void> => {
        await this.store.set(key, structuredClone(state));
      },
      withRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        let entered = false;
        const signal =
          this.refreshLockTimeoutMs === undefined
            ? undefined
            : AbortSignal.timeout(this.refreshLockTimeoutMs);
        const waitForExisting = async (): Promise<void> => {
          while (true) {
            const active = this.activeRefreshes.get(key);
            if (active === undefined) return;
            if (signal === undefined) {
              await active;
              continue;
            }
            if (signal.aborted) throw new McpRefreshLockBusyError();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => reject(new McpRefreshLockBusyError());
              signal.addEventListener("abort", onAbort, { once: true });
              active.finally(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              });
            });
          }
        };
        await waitForExisting();
        let releaseLocal!: () => void;
        const local = new Promise<void>((resolve) => {
          releaseLocal = resolve;
        });
        this.activeRefreshes.set(key, local);
        try {
          return await withFileLock(
            refreshLockPath,
            async () => {
              entered = true;
              return await fn();
            },
            signal,
          );
        } catch (error) {
          if (!entered && isLockTimeoutError(error)) {
            throw new McpRefreshLockBusyError();
          }
          throw error;
        } finally {
          releaseLocal();
          if (this.activeRefreshes.get(key) === local) {
            this.activeRefreshes.delete(key);
          }
        }
      },
    };
  }

  async hasTokens(name: string, serverUrl: string): Promise<boolean> {
    return (await this.getTokenSummary(name, serverUrl)).hasTokens;
  }

  async getTokenSummary(name: string, serverUrl: string): Promise<McpOAuthTokenSummary> {
    const state = await this.forServer(name, serverUrl).load();
    const hasTokens = Boolean(state?.tokens?.access_token);
    if (!hasTokens) return { hasTokens: false };
    return {
      hasTokens: true,
      ...(state?.tokensExpireAt === undefined ? {} : { expiresAt: state.tokensExpireAt }),
    };
  }

  async remove(name: string, serverUrl: string): Promise<boolean> {
    return this.store.delete(mcpOAuthStoreKey(name, serverUrl));
  }
}

export function toMcpOAuthSettings(
  oauth: McpOAuthConfig | McpOAuthSettings | undefined,
  env?: Readonly<Record<string, string | undefined>>,
): McpOAuthSettings {
  if (oauth === undefined) return { clientRegistration: "dcr" };
  let clientSecret = oauth.clientSecret;
  if (clientSecret !== undefined) {
    const resolved = resolveConfigValue(clientSecret, env);
    if (resolved === undefined) {
      throw new Error("MCP OAuth clientSecret could not be resolved");
    }
    clientSecret = resolved;
  }
  const metadataUrl =
    oauth.authServerMetadataUrl === undefined
      ? undefined
      : oauth.authServerMetadataUrl instanceof URL
        ? oauth.authServerMetadataUrl
        : new URL(oauth.authServerMetadataUrl);
  // Eevee does not host pi.dev Client ID Metadata Documents, so "auto" resolves to DCR.
  const registration =
    oauth.clientRegistration === undefined || oauth.clientRegistration === "auto"
      ? "dcr"
      : oauth.clientRegistration;
  return {
    ...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort }),
    ...(oauth.callbackUrl === undefined ? {} : { callbackUrl: oauth.callbackUrl }),
    ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
    ...(oauth.clientName === undefined ? {} : { clientName: oauth.clientName }),
    clientRegistration: registration,
    ...(metadataUrl === undefined ? {} : { authServerMetadataUrl: metadataUrl }),
  };
}

export type CreateEeveeMcpAuthProviderOptions = {
  readonly name: string;
  readonly serverUrl: string;
  readonly store: McpOAuthCredentialStore | McpOAuthServerStore;
  readonly settings?:
    | McpOAuthConfig
    | McpOAuthSettings
    | (() => McpOAuthConfig | McpOAuthSettings | undefined);
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onChallenge?: (challenge: OAuthChallenge) => void;
  readonly redirectUrl?: string;
};

export function createEeveeMcpAuthProvider(
  options: CreateEeveeMcpAuthProviderOptions,
): McpAuthProvider {
  const serverStore =
    options.store instanceof McpOAuthCredentialStore
      ? options.store.forServer(options.name, options.serverUrl)
      : options.store;
  return createMcpAuthProvider({
    serverUrl: options.serverUrl,
    store: serverStore,
    clientName: "eevee",
    settings: () => {
      const raw = typeof options.settings === "function" ? options.settings() : options.settings;
      return toMcpOAuthSettings(raw, options.env);
    },
    onChallenge: (challenge) => {
      options.onChallenge?.(challenge);
    },
    ...(options.redirectUrl === undefined ? {} : { redirectUrl: options.redirectUrl }),
  });
}

export type McpOAuthSignInEvent =
  | {
      readonly type: "auth_url";
      readonly url: string;
      readonly redirectUrl: string;
      readonly instructions?: string;
    }
  | { readonly type: "progress"; readonly message: string }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export type StartMcpOAuthSignInOptions = {
  readonly name: string;
  readonly serverUrl: string;
  readonly store: McpOAuthCredentialStore;
  readonly settings?: McpOAuthConfig | McpOAuthSettings;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly challenge?: OAuthChallenge;
  readonly loopback?: boolean;
  readonly redirectUrl?: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: McpOAuthSignInEvent) => void;
};

export type McpOAuthSession = {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly history: readonly McpOAuthSignInEvent[];
  readonly done: Promise<void>;
  subscribe(listener: (event: McpOAuthSignInEvent) => void): () => void;
  waitForAuthUrl(): Promise<string | undefined>;
  submitRedirectUrl(redirectUrl: string): void;
  cancel(): void;
};

export function startMcpOAuthSignIn(options: StartMcpOAuthSignInOptions): McpOAuthSession {
  const id = randomUUID();
  const abortController = new AbortController();
  const signal =
    options.signal === undefined
      ? abortController.signal
      : AbortSignal.any([abortController.signal, options.signal]);
  const history: McpOAuthSignInEvent[] = [];
  const subscribers = new Set<(event: McpOAuthSignInEvent) => void>();

  let terminal = false;
  let cancelled = false;
  let currentAuthorization: McpSignInRedirect | undefined;
  let queuedManualInput: string | undefined;
  let manualInputReady = false;
  let resolveManualInput: ((value: string | undefined) => void) | undefined;

  const setManualInput = (value: string | undefined): void => {
    if (manualInputReady) return;
    manualInputReady = true;
    queuedManualInput = value;
    const resolve = resolveManualInput;
    resolveManualInput = undefined;
    resolve?.(value);
  };

  let resolveAuthUrl!: (url: string | undefined) => void;
  let rejectAuthUrl!: (error: Error) => void;
  let authUrlSettled = false;
  const authUrlPromise = new Promise<string | undefined>((resolve, reject) => {
    resolveAuthUrl = (url) => {
      if (authUrlSettled) return;
      authUrlSettled = true;
      resolve(url);
    };
    rejectAuthUrl = (error) => {
      if (authUrlSettled) return;
      authUrlSettled = true;
      reject(error);
    };
  });
  authUrlPromise.catch(() => undefined);

  const emit = (event: McpOAuthSignInEvent): void => {
    history.push(event);
    if (options.onEvent !== undefined) {
      try {
        options.onEvent(event);
      } catch {
        // Isolate observer failures from the sign-in flow.
      }
    }
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(event);
      } catch {
        // Isolate subscriber failures from the sign-in flow.
      }
    }
  };

  const serverStore = options.store.forServer(options.name, options.serverUrl);

  const waitForManualRedirect = (waitSignal: AbortSignal): Promise<string | undefined> => {
    if (manualInputReady) return Promise.resolve(queuedManualInput);
    if (waitSignal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!manualInputReady) {
          manualInputReady = true;
          resolveManualInput = undefined;
          resolve(undefined);
        }
      };
      waitSignal.addEventListener("abort", onAbort, { once: true });
      resolveManualInput = (value) => {
        waitSignal.removeEventListener("abort", onAbort);
        resolve(value);
      };
    });
  };

  const waitForManualResponse = (
    authorization: McpSignInRedirect,
  ): Promise<McpAuthorizationResponse> =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(new McpSignInCancelledError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      waitForManualRedirect(signal).then((input) => {
        signal.removeEventListener("abort", onAbort);
        if (!input?.trim()) {
          reject(new McpSignInCancelledError());
          return;
        }
        try {
          resolve(responseFromRedirectUrl(input, authorization));
        } catch (error) {
          reject(error);
        }
      }, reject);
    });

  const done = (async () => {
    let loopbackCallback: Awaited<ReturnType<typeof listenForLoopbackSignIn>> | undefined;
    try {
      if (signal.aborted) throw new McpSignInCancelledError();
      const settings = toMcpOAuthSettings(options.settings, options.env);
      const useLoopback = options.loopback !== false;
      let redirectUrl = options.redirectUrl ?? DEFAULT_REDIRECT_URL;
      if (useLoopback) {
        loopbackCallback = await listenForLoopbackSignIn({
          serverUrl: options.serverUrl,
          store: serverStore,
          settings,
        });
        redirectUrl = loopbackCallback.redirectUrl;
      }

      const clientOptions = {
        serverUrl: options.serverUrl,
        store: serverStore,
        settings,
        clientName: "eevee",
      };

      const start = await startMcpSignIn({
        ...clientOptions,
        redirectUrl,
        ...(options.challenge === undefined ? {} : { challenge: options.challenge }),
        signal,
      });

      if (start.kind === "authorized") {
        resolveAuthUrl(undefined);
        terminal = true;
        emit({ type: "complete" });
        return;
      }

      currentAuthorization = start;
      const instructions = useLoopback
        ? "Open the URL in your browser to sign in, or paste the final redirect URL if the browser cannot reach localhost."
        : "Open the URL in your browser to sign in, then paste the final redirect URL.";
      emit({
        type: "auth_url",
        url: start.authorizationUrl,
        redirectUrl: start.redirectUrl,
        instructions,
      });
      resolveAuthUrl(start.authorizationUrl);

      const response =
        loopbackCallback !== undefined
          ? await waitForLoopbackSignIn({
              callback: loopbackCallback.callback,
              authorization: start,
              promptForRedirectUrl: waitForManualRedirect,
              signal,
            })
          : await waitForManualResponse(start);

      emit({ type: "progress", message: "Exchanging authorization code for tokens..." });
      await completeMcpSignIn({
        ...clientOptions,
        redirectUrl,
        ...(options.challenge === undefined ? {} : { challenge: options.challenge }),
        authorization: start,
        response,
        signal,
      });

      terminal = true;
      emit({ type: "complete" });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const isCancelled = cancelled || error instanceof McpSignInCancelledError || signal.aborted;
      const code = isCancelled ? "login_cancelled" : "login_failed";
      const message = isCancelled ? "Sign-in cancelled" : normalized.message;
      rejectAuthUrl(normalized);
      terminal = true;
      emit({ type: "error", code, message });
    } finally {
      currentAuthorization = undefined;
      if (loopbackCallback !== undefined) {
        await loopbackCallback.callback.close().catch(() => undefined);
      }
      subscribers.clear();
    }
  })();

  return {
    id,
    name: options.name,
    serverUrl: options.serverUrl,
    history,
    done,
    subscribe(listener) {
      for (const event of history) {
        listener(event);
      }
      if (terminal) return () => {};
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    waitForAuthUrl() {
      return authUrlPromise;
    },
    submitRedirectUrl(redirectUrl: string) {
      if (terminal) {
        throw new Error("MCP OAuth sign-in session has ended");
      }
      if (currentAuthorization === undefined) {
        throw new Error("MCP OAuth sign-in is not waiting for a redirect URL");
      }
      // Validate up front so an invalid pasted URL reports immediately without killing loopback wait.
      responseFromRedirectUrl(redirectUrl, currentAuthorization);
      setManualInput(redirectUrl);
    },
    cancel() {
      if (terminal) return;
      cancelled = true;
      setManualInput(undefined);
      abortController.abort(new McpSignInCancelledError());
    },
  };
}
