import type { Schema, Static } from "@earendil-works/pi-schema";
import {
  type Problem,
  ProblemSchema,
  parseWithSchema,
  validateWithSchema,
} from "../schemas/common.ts";
import { parseSseStream, type SseEvent } from "../sse.ts";

export class EeveeApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail ? `${problem.message}: ${problem.detail}` : problem.message);
    this.name = "EeveeApiError";
    this.status = status;
    this.problem = problem;
  }
}

export type FetchCredentials = "omit" | "same-origin" | "include";

export type SseRequestOptions<T = unknown> = {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly isTerminal?: (event: T) => boolean;
};

export type EeveeClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly credentials?: FetchCredentials;
  readonly fetch?: typeof globalThis.fetch;
};

export function parseJsonString(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export class HttpTransport {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #credentials?: FetchCredentials;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: EeveeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get<S extends Schema>(path: string, schema: S, signal?: AbortSignal): Promise<Static<S>> {
    return this.requestJson("GET", path, schema, undefined, signal);
  }

  post<S extends Schema>(
    path: string,
    schema: S,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Static<S>> {
    return this.requestJson("POST", path, schema, body, signal);
  }

  put<S extends Schema>(
    path: string,
    schema: S,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Static<S>> {
    return this.requestJson("PUT", path, schema, body, signal);
  }

  patch<S extends Schema>(
    path: string,
    schema: S,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Static<S>> {
    return this.requestJson("PATCH", path, schema, body, signal);
  }

  del<S extends Schema>(path: string, schema: S, signal?: AbortSignal): Promise<Static<S>> {
    return this.requestJson("DELETE", path, schema, undefined, signal);
  }

  async requestJson<S extends Schema>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Static<S>> {
    const hasBody = body !== undefined;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: this.#headers("application/json", hasBody),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await this.#readApiError(response);
    }

    const text = await response.text();
    const raw = parseJsonString(text, `${method} ${path}`);
    return parseWithSchema(schema, raw, `${method} ${path} response`);
  }

  async requestSse(
    path: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "GET",
      headers: this.#headers("text/event-stream", false, extraHeaders),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await this.#readApiError(response);
    }
    if (response.body === null) {
      throw new Error(`Expected SSE response body from GET ${path}`);
    }
    return response;
  }

  async *streamSse(
    path: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): AsyncGenerator<SseEvent> {
    const response = await this.requestSse(path, signal, extraHeaders);
    yield* parseSseStream(response.body, signal);
  }

  async *streamDecodedSse<T>(
    path: string,
    options: SseRequestOptions<T> | undefined,
    decode: (frame: SseEvent) => T | undefined,
  ): AsyncGenerator<T> {
    for await (const sse of this.streamSse(path, options?.signal, options?.headers)) {
      const decoded = decode(sse);
      if (decoded === undefined) continue;
      yield decoded;
      if (options?.isTerminal?.(decoded)) return;
    }
  }

  decodeSseEvent<S extends Schema>(sse: SseEvent, schema: S, label: string): Static<S> {
    return parseWithSchema(schema, parseJsonString(sse.data, label), label);
  }

  #headers(
    accept: string,
    hasBody: boolean,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept, ...extra };
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.#token !== undefined) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #readApiError(response: Response): Promise<EeveeApiError> {
    const text = await response.text().catch(() => "");
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        const checked = validateWithSchema(ProblemSchema, parsed);
        if (checked.ok) return new EeveeApiError(response.status, checked.value);
      } catch {}
    }
    const fallbackMessage = response.statusText || `HTTP ${response.status}`;
    return new EeveeApiError(response.status, {
      code: "http_error",
      message: fallbackMessage,
      ...(text.length > 0 ? { detail: text } : {}),
    });
  }
}
