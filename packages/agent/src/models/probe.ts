import type { ModelAuth, ModelInputModality } from "@earendil-works/pi-ai";
import { errorMessage, isRecord } from "../shared/guards.ts";
import { AUTH_HEADERS } from "./auth-headers.ts";
import { extractAuthSecrets, redactSecrets, withAbortTimeout } from "./sanitize.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const MAX_MODELS = 2000;
const MAX_PAGES = 10;

export type ProbedModel = {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly ModelInputModality[];
  readonly reasoning?: boolean;
};

export type ProviderProbeResult = {
  readonly models: readonly ProbedModel[];
  readonly url: string;
  readonly pageCount: number;
  readonly truncated: boolean;
};

export type ProbeProviderModelsOptions = {
  readonly baseUrl: string;
  readonly auth?: ModelAuth;
  readonly api?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export function modelCatalogUrl(base: URL, api?: string): URL {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (api === "anthropic-messages" && !/\/v1(?:\/anthropic)?$/i.test(path)) {
    url.pathname = `${path}/v1/models`.replace(/^\/\//, "/");
  } else {
    url.pathname = `${path}/models`.replace(/^\/\//, "/");
  }
  return url;
}

function setHeader(headers: Record<string, string>, name: string, value: string | null): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  if (value !== null) headers[name] = value;
}

function requestHeaders(
  auth: ModelAuth | undefined,
  api: string | undefined,
  bearerFallback: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth?.apiKey) {
    if (api === "anthropic-messages" && !bearerFallback) {
      setHeader(headers, AUTH_HEADERS.anthropic, auth.apiKey);
      setHeader(headers, "anthropic-version", "2023-06-01");
    } else if (api === "google-generative-ai" || api === "google-vertex") {
      setHeader(headers, AUTH_HEADERS.google, auth.apiKey);
    } else {
      setHeader(headers, AUTH_HEADERS.authorization, `Bearer ${auth.apiKey}`);
    }
  } else if (api === "anthropic-messages" && !bearerFallback) {
    setHeader(headers, "anthropic-version", "2023-06-01");
  }
  for (const [name, value] of Object.entries(auth?.headers ?? {})) {
    setHeader(headers, name, value);
  }
  return headers;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!response.body) {
    const bytes = new TextEncoder().encode(await response.text());
    return {
      text: new TextDecoder().decode(bytes.slice(0, maxBytes)),
      truncated: bytes.byteLength > maxBytes,
    };
  }
  const reader = response.body.getReader();
  const readNext = async (): ReturnType<typeof reader.read> => {
    signal.throwIfAborted();
    let rejectAbort!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      void reader.cancel().catch(() => {});
      rejectAbort(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([reader.read(), aborted]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await readNext();
      if (next.done) break;
      const remaining = maxBytes - total;
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.slice(0, Math.max(0, remaining)));
        total += Math.max(0, remaining);
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total === maxBytes) {
        const lookahead = await readNext();
        if (!lookahead.done) {
          truncated = true;
          await reader.cancel().catch(() => {});
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelInput(entry: Record<string, unknown>): readonly ModelInputModality[] | undefined {
  const capabilities = entry.capabilities as Record<string, unknown> | undefined;
  const value = entry.input ?? entry.input_modalities ?? capabilities?.input;
  if (!Array.isArray(value)) return undefined;
  const input = value.filter(
    (modality): modality is ModelInputModality => modality === "text" || modality === "image",
  );
  return input.length > 0 ? [...new Set(input)] : undefined;
}

function modelReasoning(entry: Record<string, unknown>): boolean | undefined {
  if (typeof entry.reasoning === "boolean") return entry.reasoning;
  const capabilities = entry.capabilities as Record<string, unknown> | undefined;
  if (typeof capabilities?.reasoning === "boolean") return capabilities.reasoning;
  if (Array.isArray(entry.supported_features)) {
    return entry.supported_features.some(
      (feature) => feature === "reasoning" || feature === "thinking",
    );
  }
  return undefined;
}

function parseModels(payload: unknown): readonly ProbedModel[] {
  if (!isRecord(payload)) {
    throw new Error("Model catalog response must be a JSON object");
  }
  const entries = Array.isArray(payload.data) ? payload.data : payload.models;
  if (!Array.isArray(entries)) {
    throw new Error("Model catalog response has no data[] or models[] array");
  }
  const models: ProbedModel[] = [];
  for (const value of entries) {
    if (!isRecord(value)) continue;
    if (typeof value.id !== "string" || value.id.length === 0) continue;
    const name =
      typeof value.name === "string"
        ? value.name
        : typeof value.display_name === "string"
          ? value.display_name
          : undefined;
    const contextWindow =
      finiteNumber(value.contextWindow) ??
      finiteNumber(value.context_window) ??
      finiteNumber(value.context_length);
    const maxTokens =
      finiteNumber(value.maxTokens) ??
      finiteNumber(value.max_output_tokens) ??
      finiteNumber(value.max_tokens);
    const input = modelInput(value);
    const reasoning = modelReasoning(value);
    models.push({
      id: value.id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(input ? { input } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    });
  }
  return models;
}

function fallbackUrl(url: URL): URL {
  const next = new URL(url);
  next.pathname = next.pathname.replace(/\/anthropic(?:\/v1)?(?=\/models\/?$)/i, "");
  return next;
}

export async function probeProviderModels(
  options: ProbeProviderModelsOptions,
): Promise<ProviderProbeResult> {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("Provider probe requires an absolute HTTP(S) base URL");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authSecrets = extractAuthSecrets(options.auth);

  return withAbortTimeout(timeoutMs, options.signal, async ({ signal, timedOut }) => {
    try {
      let current = modelCatalogUrl(base, options.api);
      let bearerFallback = false;
      let pageCount = 0;
      let truncated = false;
      const models: ProbedModel[] = [];
      const seen = new Set<string>();

      for (let page = 0; page < MAX_PAGES; page++) {
        signal.throwIfAborted();
        const response = await fetchImpl(current, {
          headers: requestHeaders(options.auth, options.api, bearerFallback),
          signal,
        });
        if (!response.ok) {
          const body = await readBoundedBody(response, MAX_ERROR_BYTES, signal);
          const canFallback =
            options.api === "anthropic-messages" &&
            !bearerFallback &&
            page === 0 &&
            [401, 403, 404].includes(response.status);
          if (canFallback) {
            current = fallbackUrl(current);
            bearerFallback = true;
            page--;
            continue;
          }
          throw new Error(
            `Provider probe failed (${response.status}): ${body.text.slice(0, MAX_ERROR_BYTES)}${body.truncated ? "…" : ""}`,
          );
        }

        const body = await readBoundedBody(response, MAX_BODY_BYTES, signal);
        if (body.truncated) throw new Error("Provider model catalog exceeded 8 MiB");
        const payload: unknown = JSON.parse(body.text);
        const parsed = parseModels(payload);
        pageCount++;
        for (const model of parsed) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          models.push(model);
          if (models.length === MAX_MODELS) break;
        }
        if (models.length >= MAX_MODELS) {
          truncated = true;
          break;
        }

        const record = payload as Record<string, unknown>;
        const canPaginate =
          (options.api === undefined || options.api === "anthropic-messages") && !bearerFallback;
        if (!canPaginate || record.has_more !== true || typeof record.last_id !== "string") break;
        if (page + 1 === MAX_PAGES) {
          truncated = true;
          break;
        }
        current = new URL(current);
        current.searchParams.set("after_id", record.last_id);
      }

      return { models, url: current.toString(), pageCount, truncated };
    } catch (error) {
      if (timedOut()) {
        throw new Error(
          redactSecrets(
            `Provider probe timed out after ${timeoutMs}ms`,
            authSecrets,
            MAX_ERROR_BYTES,
          ),
        );
      }
      if (options.signal?.aborted) {
        throw new Error(redactSecrets("Provider probe aborted", authSecrets, MAX_ERROR_BYTES));
      }
      throw new Error(redactSecrets(errorMessage(error), authSecrets, MAX_ERROR_BYTES));
    }
  });
}
