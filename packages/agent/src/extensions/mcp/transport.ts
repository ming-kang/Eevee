import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AuthProvider,
  McpAbortError,
  McpAuthRequiredError,
  McpError,
  McpHttpError,
  type McpOutputSaver,
  type McpTransport,
  type Root,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import {
  type McpAuthProvider,
  McpOAuthAuthorizationRequiredError,
} from "@earendil-works/pi-mcp/oauth";
import { expandHome } from "../../shared/paths.ts";
import { type McpServerEntry, resolveServerEnv, resolveServerHeaders } from "./config.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 150;
export const DEFAULT_CLIENT_INFO = { name: "eevee", version: "0.0.1" } as const;

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
]);

export function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError
  );
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCodeOf(error.cause);
  return undefined;
}

export function isTransientError(error: unknown): boolean {
  if (isAuthRequiredError(error)) return false;
  if (error instanceof McpAbortError) return false;
  if (error instanceof McpError) return false;
  if (error instanceof McpHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  const code = errorCodeOf(error);
  return code !== undefined && (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR"));
}

export function hasSettledMethod(
  provider: AuthProvider | undefined,
): provider is AuthProvider & McpAuthProvider {
  return provider !== undefined && "settled" in provider && typeof provider.settled === "function";
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function sameConfig(left: McpServerEntry, right: McpServerEntry): boolean {
  return stableJson(left.config) === stableJson(right.config);
}

export function definedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function toMcpRoots(dirs: readonly string[], cwd: string): Root[] {
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const dir of dirs) {
    const abs = resolve(cwd, expandHome(dir));
    const uri = pathToFileURL(abs).href;
    if (seen.has(uri)) continue;
    seen.add(uri);
    const name = basename(abs) || abs;
    roots.push({ uri, name });
  }
  return roots;
}

export function createDefaultTransport(
  entry: McpServerEntry,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  authProvider: AuthProvider | undefined,
  onStderr: (chunk: string) => void,
): McpTransport {
  const { config } = entry;
  if ("url" in config) {
    return new StreamableHttpTransport({
      url: config.url,
      headers: resolveServerHeaders(config.headers, env),
      authProvider,
    });
  }
  const configuredEnv = resolveServerEnv(config.env, env);
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
    env: { ...definedEnv(env), ...configuredEnv },
    inheritEnv: false,
    stderr: "pipe",
    onStderr,
  });
}

export function createDefaultOutputSaver(): McpOutputSaver {
  let directory: Promise<string> | undefined;
  return async (data, extension) => {
    directory ??= mkdtemp(join(tmpdir(), "eevee-mcp-"));
    const dir = await directory;
    const safeExtension = /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : ".bin";
    const path = join(dir, `output-${randomUUID()}${safeExtension}`);
    await writeFile(path, data, { mode: 0o600 });
    return path;
  };
}

export function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new McpAbortError(String(signal.reason)),
    );
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        signal?.reason instanceof Error
          ? signal.reason
          : new McpAbortError(String(signal?.reason ?? "Aborted")),
      );
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error(timeoutMessage));
      }, timeoutMs);
      timer.unref?.();
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}
