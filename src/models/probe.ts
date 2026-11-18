/**
 * Lists the models an endpoint serves, so a new provider's models can be picked instead of typed. Follows the
 * catalog shapes OpenAI-style servers share (`data[]`, `models[]` or a bare array), and keeps the metadata an
 * entry declares under the common field names. Anthropic-style endpoints that turn down the Anthropic request
 * get one OpenAI-style retry on the same origin, and Anthropic catalogs are followed through their pages.
 */
import type { FetchFunction, ModelAuth } from "@earendil-works/pi-ai";
import { ProblemError } from "../contracts/index.ts";

/** A catalog entry, with the fields models.json takes that it declared. */
export type ProbedModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
};

export type ProbeResult = { models: ProbedModel[]; truncated: boolean };

export const PROBE_LIMITS = {
  timeoutMs: 10_000,
  maxBodyBytes: 4 * 1024 * 1024,
  maxErrorBytes: 4_096,
  maxErrorChars: 400,
  maxModels: 2_000,
  /** Anthropic catalog pages followed through `has_more`, the first one included. */
  maxPages: 5,
} as const;

export type ProbeOptions = {
  baseUrl: string;
  api?: string;
  /** Resolved credentials; none asks the catalog anonymously. */
  auth?: ModelAuth;
  fetch?: FetchFunction;
  timeoutMs?: number;
};

type Page = { ok: true; json: unknown } | { ok: false; status?: number; error: string };

/** Refuses with `probe_failed`, naming what went wrong without repeating a credential. */
export async function probeModels(options: ProbeOptions): Promise<ProbeResult> {
  const base = parseBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? PROBE_LIMITS.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const doFetch = options.fetch ?? globalThis.fetch;
  const fail = (detail: string) =>
    new ProblemError({ code: "probe_failed", detail: redact(detail, options.auth) });

  const getPage = async (url: URL, headers: Headers): Promise<Page> => {
    const response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      const body = await readBounded(response, PROBE_LIMITS.maxErrorBytes).catch(() => "");
      const text = body.trim().slice(0, PROBE_LIMITS.maxErrorChars);
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
      };
    }
    const text = await readBounded(response, PROBE_LIMITS.maxBodyBytes);
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return { ok: false, error: "The response isn't JSON" };
    }
  };

  try {
    let url = catalogUrl(base, options.api);
    let headers = requestHeaders(options.auth, options.api);
    let page = await getPage(url, headers);
    if (!page.ok) {
      const retry = openAIStyleRetry(base, options.auth, options.api, url, headers, page.status);
      if (retry === undefined) throw fail(page.error);
      const retried = await getPage(retry.url, retry.headers);
      if (!retried.ok) {
        throw fail(`${url.href} → ${page.error}; ${retry.url.href} → ${retried.error}`);
      }
      ({ url, headers } = retry);
      page = retried;
    }
    const models = parseCatalog(page.json);
    if (models === undefined) {
      throw fail(
        "The response has no model list as data[] or models[]; you can add the model by hand",
      );
    }
    let json = page.json;
    for (
      let pages = 1;
      options.api === "anthropic-messages" &&
      pages < PROBE_LIMITS.maxPages &&
      models.length < PROBE_LIMITS.maxModels;
      pages++
    ) {
      const cursor = nextCursor(json);
      if (cursor === undefined) break;
      const next = new URL(url.href);
      next.searchParams.set("after_id", cursor);
      next.searchParams.set("limit", "1000");
      const more = await getPage(next, headers);
      const parsed = more.ok ? parseCatalog(more.json) : undefined;
      if (!more.ok || parsed === undefined) break;
      models.push(...parsed);
      if (nextCursor(more.json) === cursor) break;
      json = more.json;
    }
    const unique = [...new Map(models.map((m) => [m.id, m])).values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return {
      models: unique.slice(0, PROBE_LIMITS.maxModels),
      truncated: unique.length > PROBE_LIMITS.maxModels || hasMore(json),
    };
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    if (controller.signal.aborted) throw fail(`No response within ${timeoutMs / 1000}s`);
    throw fail(describeError(error));
  } finally {
    clearTimeout(timer);
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProblemError({ code: "invalid", field: "baseUrl" });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ProblemError({ code: "invalid", field: "baseUrl" });
  }
  return url;
}

/** `{baseUrl}/models`; Anthropic's lives under `/v1`, which its baseUrl leaves out. */
export function catalogUrl(base: URL, api?: string): URL {
  const url = new URL(base.href);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname =
    api === "anthropic-messages" && !path.endsWith("/v1") ? `${path}/v1/models` : `${path}/models`;
  return url;
}

/**
 * Anthropic-style gateways often serve their catalog OpenAI-style only: one retry with a bearer token, at the
 * baseUrl without a trailing `/anthropic`, on the same origin, unless an `Authorization` header is configured.
 */
function openAIStyleRetry(
  base: URL,
  auth: ModelAuth | undefined,
  api: string | undefined,
  first: URL,
  firstHeaders: Headers,
  status: number | undefined,
): { url: URL; headers: Headers } | undefined {
  if (api !== "anthropic-messages" || ![401, 403, 404].includes(status ?? 0)) return undefined;
  if (Object.keys(auth?.headers ?? {}).some((k) => k.toLowerCase() === "authorization")) {
    return undefined;
  }
  const root = new URL(base.href);
  root.pathname = root.pathname.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
  const url = catalogUrl(root, api);
  const headers = requestHeaders(auth, undefined);
  const same =
    url.href === first.href && headers.get("authorization") === firstHeaders.get("authorization");
  return same ? undefined : { url, headers };
}

function requestHeaders(auth: ModelAuth | undefined, api: string | undefined): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (api === "anthropic-messages") headers.set("anthropic-version", "2023-06-01");
  const configured = auth?.headers ?? {};
  let hasAuthorization = false;
  for (const [key, value] of Object.entries(configured)) {
    if (key.toLowerCase() === "authorization") hasAuthorization = true;
    if (typeof value === "string") headers.set(key, value);
    else if (value === null) headers.delete(key);
  }
  const key = auth?.apiKey;
  if (!key || hasAuthorization) return headers;
  if (api === "anthropic-messages") {
    if (!headers.has("x-api-key")) headers.set("x-api-key", key);
  } else if (api === "google-generative-ai" || api === "google-vertex") {
    if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", key);
  } else {
    headers.set("authorization", `Bearer ${key}`);
  }
  return headers;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`The response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** An error's words, with the cause a network failure keeps underneath (`fetch failed` alone says little). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
}

function redact(text: string, auth: ModelAuth | undefined): string {
  let out = text;
  for (const value of [auth?.apiKey, ...Object.values(auth?.headers ?? {})]) {
    if (typeof value !== "string" || value === "") continue;
    out = out.replaceAll(value, "[redacted]");
    const token = value.replace(/^Bearer\s+/i, "");
    if (token !== value && token !== "") out = out.replaceAll(token, "[redacted]");
  }
  return out;
}

function hasMore(json: unknown): boolean {
  return isRecord(json) && json.has_more === true;
}

function nextCursor(json: unknown): string | undefined {
  if (!hasMore(json)) return undefined;
  const last = (json as { last_id?: unknown }).last_id;
  return typeof last === "string" && last !== "" ? last : undefined;
}

// Catalogs name the same metadata differently; each list holds the paths seen in real `/models` answers.
const CONTEXT_WINDOW = [
  "context_window",
  "context_window.tokens",
  "context_length",
  "top_provider.context_length",
  "max_input_tokens",
  "max_context_length",
  "max_model_len",
  "context_size",
  "metadata.context_length",
];
const MAX_TOKENS = [
  "max_output_tokens",
  "max_completion_tokens",
  "top_provider.max_completion_tokens",
  "max_tokens",
  "max_output_length",
];
const INPUT_MODALITIES = ["input_modalities", "architecture.input_modalities", "modalities.input"];
const IMAGE_FLAGS = [
  "supports_vision",
  "enable_vision_input",
  "capabilities.vision",
  "capabilities.image_input.supported",
];
const REASONING_FLAGS = [
  "reasoning",
  "supports_reasoning",
  "enable_reason",
  "capabilities.reasoning",
  "capabilities.thinking.supported",
];
const REASONING_LEVELS = ["effort.supported_levels", "reasoning_effort_support_list"];
const CAPABILITY_LISTS = [
  "supported_parameters",
  "tags",
  "features",
  "supported_features",
  "metadata.tags",
];

function fieldAt(record: Record<string, unknown>, path: string): unknown {
  let value: unknown = record;
  for (const key of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

function listAt(record: Record<string, unknown>, path: string): string[] {
  const value = fieldAt(record, path);
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase())
    : [];
}

/**
 * Only positive integers count (some catalogs write 0 for unknown). When fields disagree the smallest wins:
 * overstating a limit overflows requests, understating it only compacts earlier.
 */
function declaredLimit(
  record: Record<string, unknown>,
  paths: readonly string[],
): number | undefined {
  let limit: number | undefined;
  for (const path of paths) {
    const value = fieldAt(record, path);
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      limit = Math.min(limit ?? value, value);
    }
  }
  return limit;
}

/** The models a catalog lists, or undefined when it is not a catalog. */
export function parseCatalog(json: unknown): ProbedModel[] | undefined {
  const list = Array.isArray(json)
    ? json
    : isRecord(json)
      ? Array.isArray(json.models)
        ? json.models
        : json.data
      : undefined;
  if (!Array.isArray(list)) return undefined;
  const models: ProbedModel[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = text(item.id) ?? text(item.slug);
    if (id === undefined) continue;
    const label = text(item.name) ?? text(item.display_name) ?? text(item.displayName);
    const model: ProbedModel = {
      id,
      ...(label !== undefined && label !== id ? { name: label } : {}),
    };
    const contextWindow = declaredLimit(item, CONTEXT_WINDOW);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const maxTokens = declaredLimit(item, MAX_TOKENS);
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
    const image =
      INPUT_MODALITIES.some((p) => listAt(item, p).includes("image")) ||
      IMAGE_FLAGS.some((p) => fieldAt(item, p) === true) ||
      CAPABILITY_LISTS.some((p) => listAt(item, p).includes("vision"));
    if (image) model.input = ["text", "image"];
    const reasoning =
      REASONING_FLAGS.some((p) => fieldAt(item, p) === true) ||
      REASONING_LEVELS.some((p) => listAt(item, p).length > 0) ||
      CAPABILITY_LISTS.some((p) => listAt(item, p).includes("reasoning"));
    if (reasoning) model.reasoning = true;
    models.push(model);
  }
  return list.length > 0 && models.length === 0 ? undefined : models;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
