import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationWindow, EntryId } from "@earendil-works/pi-durable";
import type { Schema, Static } from "@earendil-works/pi-schema";
import type {
  ListWorkerTasksOptions as CoreListWorkerTasksOptions,
  OutputReadOptions,
} from "@eevee/core";
import {
  type ConversationRef,
  ConversationRefSchema,
  EntriesQuerySchema,
  ListWorkerTasksQuerySchema,
  ModelsQuerySchema,
  type Problem,
  ProjectIdSchema,
  parseWithSchema,
  type QuestionId,
  QuestionIdSchema,
  ReadWorkerTaskQuerySchema,
  type StreamWorkerTaskQuery,
  StreamWorkerTaskQuerySchema,
  validateTaskReadOptions,
  WindowQuerySchema,
  type WorkerId,
  WorkerIdSchema,
} from "@eevee/protocol";
import { EngineError, type ListEntriesParams } from "./engine.ts";
import { parseQueryParams } from "./engine-error.ts";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendProblem(
  res: ServerResponse,
  status: number,
  problem: Problem,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, problem, extraHeaders);
}

export function sendMethodNotAllowed(res: ServerResponse, method: string, allow: string): void {
  sendProblem(
    res,
    405,
    { code: "method_not_allowed", message: `Method ${method} not allowed` },
    { Allow: allow },
  );
}

async function readRawBodyText(req: IncomingMessage): Promise<string> {
  const contentLengthHeader = req.headers["content-length"];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
      req.resume();
      throw new EngineError(
        413,
        "payload_too_large",
        `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
      );
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      chunks.length = 0;
      tooLarge = true;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }

  if (tooLarge) {
    throw new EngineError(
      413,
      "payload_too_large",
      `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
    );
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBodyText(req);
  if (text.length === 0) {
    throw new EngineError(400, "invalid_json", "Request body must not be empty");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_json",
      "Malformed JSON request body",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBodyText(req);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_json",
      "Malformed JSON request body",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readBody<S extends Schema>(
  req: IncomingMessage,
  schema: S,
  label: string,
): Promise<Static<S>> {
  return parseWithSchema(schema, await readJsonBody(req), label);
}

export async function readOptionalBody<S extends Schema>(
  req: IncomingMessage,
  schema: S,
  label: string,
): Promise<Static<S>> {
  return parseWithSchema(schema, await readOptionalJsonBody(req), label);
}

type QueryCoercer = (raw: string, key: string) => unknown;

function queryInt(raw: string, key: string): number {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new EngineError(400, "invalid_query", `Query parameter ${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new EngineError(400, "invalid_query", `Query parameter ${key} must be a safe integer`);
  }
  return value;
}

function queryBool(raw: string, key: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new EngineError(400, "invalid_query", `Query parameter ${key} must be true or false`);
}

const queryString: QueryCoercer = (raw) => raw;
const queryOptionalNonEmptyString: QueryCoercer = (raw) => (raw.length > 0 ? raw : undefined);

function parseQueryWithSchema<S extends Schema>(
  url: URL,
  schema: S,
  fields: Readonly<Record<keyof Static<S> & string, QueryCoercer>>,
): Static<S> {
  const candidate: Record<string, unknown> = {};
  for (const [key, parseField] of Object.entries(fields) as [string, QueryCoercer][]) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const parsed = parseField(raw, key);
    if (parsed !== undefined) candidate[key] = parsed;
  }
  return parseQueryParams(schema, candidate);
}

function parsePositiveInt(raw: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new EngineError(400, "invalid_query", `${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EngineError(400, "invalid_query", `${label} must be a positive safe integer`);
  }
  return value;
}

export type { StreamWorkerTaskQuery };

export function parseEntriesQuery(url: URL): ListEntriesParams {
  return parseQueryWithSchema(url, EntriesQuerySchema, {
    order: queryString,
    limit: queryInt,
    minEntryId: queryInt,
    maxEntryId: queryInt,
    cursor: queryString,
  });
}

export function parseListWorkerTasksQuery(url: URL): CoreListWorkerTasksOptions {
  return parseQueryWithSchema(url, ListWorkerTasksQuerySchema, {
    status: queryString,
    limit: queryInt,
  });
}

const TASK_STREAM_QUERY_COERCERS = {
  mode: queryString,
  bytes: queryInt,
  sinceBytes: queryInt,
} as const;

function validateTaskOutputOptions<T extends OutputReadOptions>(options: T): T {
  try {
    validateTaskReadOptions(options);
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_query",
      error instanceof Error ? error.message : String(error),
    );
  }
  return options;
}

export function parseReadWorkerTaskQuery(url: URL): OutputReadOptions {
  return validateTaskOutputOptions(
    parseQueryWithSchema(url, ReadWorkerTaskQuerySchema, {
      ...TASK_STREAM_QUERY_COERCERS,
      endByte: queryInt,
      filter: queryString,
      contextLines: queryInt,
    }),
  );
}

export function parseStreamWorkerTaskQuery(url: URL): StreamWorkerTaskQuery {
  return validateTaskOutputOptions(
    parseQueryWithSchema(url, StreamWorkerTaskQuerySchema, TASK_STREAM_QUERY_COERCERS),
  );
}

export function parseModelsQuery(url: URL): {
  readonly provider?: string;
  readonly available?: boolean;
} {
  return parseQueryWithSchema(url, ModelsQuerySchema, {
    provider: queryOptionalNonEmptyString,
    available: queryBool,
  });
}

export function parseWindowParams(url: URL, req: IncomingMessage): ConversationWindow | undefined {
  const query = parseQueryWithSchema(url, WindowQuerySchema, {
    from: queryInt,
    min: queryInt,
    max: queryInt,
  });
  const lastEventIdRaw = req.headers["last-event-id"];
  const lastEventId = typeof lastEventIdRaw === "string" ? lastEventIdRaw.trim() : undefined;

  let from = query.from as EntryId | undefined;
  if (from === undefined && lastEventId !== undefined && lastEventId.length > 0) {
    const parsedId = parsePositiveInt(lastEventId, "Header Last-Event-ID");
    from = (parsedId + 1) as EntryId;
  }

  const effectiveMin = query.min ?? 50;
  if (query.max !== undefined && query.max < effectiveMin) {
    throw new EngineError(
      400,
      "invalid_query",
      `Query parameter max (${query.max}) must be >= min (${effectiveMin})`,
    );
  }

  if (from === undefined && query.min === undefined && query.max === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { from }),
    ...(query.min === undefined ? {} : { min: query.min }),
    ...(query.max === undefined ? {} : { max: query.max }),
  };
}

function parseNonEmptySegment(raw: string, label: string): string {
  if (raw.trim().length === 0) {
    throw new EngineError(400, "invalid_request", `${label} must not be empty`);
  }
  return raw;
}

type PathParams = {
  readonly projectId: string;
  readonly ref: ConversationRef;
  readonly questionId: QuestionId;
  readonly workerId: WorkerId;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly serverName: string;
  readonly taskId: string;
};

const PATH_PARAM_PARSERS: { readonly [K in keyof PathParams]: (raw: string) => PathParams[K] } = {
  projectId: (raw) => parseWithSchema(ProjectIdSchema, raw, "projectId"),
  ref: (raw) => parseWithSchema(ConversationRefSchema, raw, "conversationRef"),
  questionId: (raw) => parseWithSchema(QuestionIdSchema, raw, "questionId"),
  workerId: (raw) => parseWithSchema(WorkerIdSchema, raw, "workerId"),
  providerId: (raw) => parseNonEmptySegment(raw, "providerId"),
  modelId: (raw) => parseNonEmptySegment(raw, "modelId"),
  sessionId: (raw) => parseNonEmptySegment(raw, "sessionId"),
  serverName: (raw) => parseNonEmptySegment(raw, "serverName"),
  taskId: (raw) => parseNonEmptySegment(raw, "taskId"),
};

type ParamName<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamName<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

type ParamKeys<Path extends string> = ParamName<Path> & keyof PathParams;

type OptionalParamKeys<Path extends string> = {
  [K in ParamKeys<Path>]: Path extends infer Branch
    ? Branch extends string
      ? K extends ParamName<Branch>
        ? never
        : K
      : never
    : never;
}[ParamKeys<Path>];

type RequiredParamKeys<Path extends string> = Exclude<ParamKeys<Path>, OptionalParamKeys<Path>>;

export type PathParamsFor<Path extends string> = {
  readonly [K in RequiredParamKeys<Path>]: PathParams[K];
} & {
  readonly [K in OptionalParamKeys<Path>]?: PathParams[K];
};

type RouteContext<Path extends string> = {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: PathParamsFor<Path>;
};

export type Route = {
  readonly method: string;
  readonly pattern: readonly string[];
  readonly handle: (context: RouteContext<string>) => Promise<void> | void;
};

export function route<Path extends string>(
  method: string,
  path: Path,
  handle: (context: RouteContext<Path>) => Promise<void> | void,
): Route {
  return {
    method,
    pattern: path.split("/").filter((part) => part.length > 0),
    handle: handle as Route["handle"],
  };
}

export function prefixedRoute<Prefix extends string, Suffix extends string>(
  method: string,
  prefix: Prefix,
  suffix: Suffix,
  handle: (context: RouteContext<`${Prefix}${Suffix}`>) => Promise<void> | void,
): Route {
  return route(method, `${prefix}${suffix}`, handle);
}

type TrieNode = {
  readonly children: Map<string, TrieNode>;
  paramChild?: { readonly name: string; readonly node: TrieNode };
  readonly routes: Map<string, Route>;
};

export type RouteTrieMatch = {
  readonly methods: ReadonlyMap<string, Route>;
  readonly allowHeader: string;
};

function createTrieNode(): TrieNode {
  return { children: new Map(), routes: new Map() };
}

export class RouteTrie {
  readonly #root: TrieNode = createTrieNode();

  constructor(routes: readonly Route[] = []) {
    for (const entry of routes) {
      this.add(entry);
    }
  }

  add(entry: Route): void {
    let node = this.#root;
    for (const part of entry.pattern) {
      if (part.startsWith(":")) {
        const name = part.slice(1);
        if (node.paramChild === undefined) {
          node.paramChild = { name, node: createTrieNode() };
        } else if (node.paramChild.name !== name) {
          throw new Error(
            `Conflicting param names ":${node.paramChild.name}" and ":${name}" at same route position`,
          );
        }
        node = node.paramChild.node;
      } else {
        let child = node.children.get(part);
        if (child === undefined) {
          child = createTrieNode();
          node.children.set(part, child);
        }
        node = child;
      }
    }
    if (node.routes.has(entry.method)) {
      throw new Error(`Duplicate route: ${entry.method} /${entry.pattern.join("/")}`);
    }
    node.routes.set(entry.method, entry);
  }

  matchPath(segments: readonly string[]): RouteTrieMatch | undefined {
    const node = this.#matchNode(this.#root, segments, 0);
    if (node === undefined || node.routes.size === 0) return undefined;
    return {
      methods: node.routes,
      allowHeader: [...node.routes.keys()].join(", "),
    };
  }

  #matchNode(node: TrieNode, segments: readonly string[], index: number): TrieNode | undefined {
    if (index === segments.length) {
      return node.routes.size > 0 ? node : undefined;
    }
    const segment = segments[index];
    if (segment === undefined) return undefined;

    const staticChild = node.children.get(segment);
    if (staticChild !== undefined) {
      const matched = this.#matchNode(staticChild, segments, index + 1);
      if (matched !== undefined) return matched;
    }

    if (node.paramChild !== undefined) {
      return this.#matchNode(node.paramChild.node, segments, index + 1);
    }

    return undefined;
  }
}

export function parsePathParams(
  pattern: readonly string[],
  segments: readonly string[],
): RouteContext<string>["params"] {
  const params: Record<string, unknown> = {};
  pattern.forEach((part, index) => {
    if (!part.startsWith(":")) return;
    const name = part.slice(1) as keyof PathParams;
    params[name] = PATH_PARAM_PARSERS[name](segments[index] ?? "");
  });
  return params;
}
