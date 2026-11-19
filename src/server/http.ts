import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { compile, type Schema, type Validator } from "@earendil-works/pi-schema";
import { ROUTE_BODIES } from "../api/bodies.ts";
import {
  type ApiError,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteResponse,
  TOKEN_HEADER,
} from "../api/contract.ts";
import { type ProblemCode, ProblemError, problemOf } from "../contracts/index.ts";
import { resolveInside } from "../shared/paths.ts";
import { type Auth, isLoopbackRequest } from "./auth.ts";

export type RouteContext<K extends RouteKey> = {
  params: RouteParams<K>;
  body: RouteBody<K>;
};

export type RouteDefinition<K extends RouteKey> = {
  public?: boolean;
  handle(context: RouteContext<K>): Promise<RouteResponse<K>>;
};

export type RouteTable = { [K in RouteKey]: RouteDefinition<K> };

export type ServerOptions = {
  routes: RouteTable;
  auth: Auth;
  uiDir: string | undefined;
};

const MAX_BODY = 1024 * 1024;

type CompiledRoute = {
  method: string;
  pattern: RegExp;
  names: string[];
  key: RouteKey;
  definition: RouteDefinition<RouteKey>;
  body: BodyCheck | undefined;
};

/** A route's body schema, compiled once at startup. */
type BodyCheck = { schema: Schema; check: Validator<unknown> };

export function createHttpServer(options: ServerOptions): Server {
  const bodies = new Map<string, BodyCheck>(
    Object.entries(ROUTE_BODIES).map(([key, schema]) => [key, { schema, check: compile(schema) }]),
  );
  const compiled: CompiledRoute[] = Object.entries(options.routes).map(([key, definition]) => {
    const [method, template] = key.split(" ") as [string, string];
    const names: string[] = [];
    const pattern = new RegExp(
      `^${template.replace(/:([a-z]+)/g, (_, name: string) => {
        names.push(name);
        return "([^/]+)";
      })}$`,
    );
    const routeKey = key as RouteKey;
    return {
      method,
      pattern,
      names,
      key: routeKey,
      definition: definition as RouteDefinition<RouteKey>,
      body: bodies.get(routeKey),
    };
  });

  return createServer(async (request, response) => {
    try {
      if (!isLoopbackRequest(request)) throw new ProblemError({ code: "forbidden_host" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname.startsWith("/ui")) {
        return await serveUi(options.uiDir, url.pathname, response);
      }
      const route = compiled.find(
        (r) => r.method === request.method && r.pattern.test(url.pathname),
      );
      if (route === undefined) {
        throw new ProblemError({
          code: "no_route",
          method: request.method ?? "",
          path: url.pathname,
        });
      }

      if (!route.definition.public && !options.auth.verify(header(request, TOKEN_HEADER))) {
        throw new ProblemError({ code: "unauthorized" });
      }
      const match = route.pattern.exec(url.pathname) ?? [];
      const params = Object.fromEntries(
        route.names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? "")]),
      );
      const body = parseBody(route.body, await readBody(request));
      // The route's own schema has checked the body; only the erased route type is left to cast.
      const result = await route.definition.handle({ params, body } as RouteContext<RouteKey>);
      sendJson(response, 200, result);
    } catch (error) {
      const problem = problemOf(error);
      if (problem.code === "internal") console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      const payload: ApiError = { error: { ...problem, message } };
      sendJson(response, STATUS[problem.code], payload);
    }
  });
}

/** The status each problem answers with; a new code has to pick one here. */
const STATUS: Record<ProblemCode, number> = {
  bad_json: 400,
  required: 400,
  invalid: 400,
  unauthorized: 401,
  bad_code: 401,
  forbidden_host: 403,
  no_route: 404,
  no_file: 404,
  no_project: 404,
  no_ticket: 404,
  no_worker: 404,
  no_question: 404,
  no_job: 404,
  no_memory_file: 404,
  no_change: 404,
  no_submission: 404,
  no_model: 404,
  no_provider: 404,
  no_extension: 404,
  model_unset: 409,
  ticket_closed: 409,
  report_changed: 409,
  answered: 409,
  already_delivered: 409,
  job_ended: 409,
  running: 409,
  not_failed: 409,
  undo_failed: 409,
  model_in_use: 409,
  bad_config: 422,
  probe_failed: 502,
  too_large: 413,
  internal: 500,
};

/**
 * A request body checked against its route's schema. An absent body counts as an empty object, so a field the
 * route needs is still reported as `required` with its name; a route without a schema takes its body as it came.
 */
function parseBody(route: BodyCheck | undefined, value: unknown): unknown {
  if (route === undefined) return value;
  const parsed = route.check.validate(value ?? {});
  if (parsed.ok) return parsed.value;
  const error = parsed.errors[0];
  const field = (error?.path ?? "").replace(/^\//, "").replaceAll("/", ".") || "body";
  if (error?.keyword === "required") throw new ProblemError({ code: "required", field });
  const allowed = error === undefined ? undefined : allowedAt(route.schema, error.path);
  throw new ProblemError({ code: "invalid", field, ...(allowed === undefined ? {} : { allowed }) });
}

/** The values an enum field takes, read from the schema where the error points, so a refusal can name them. */
function allowedAt(schema: Schema, path: string): readonly string[] | undefined {
  let node = schema as Record<string, unknown>;
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    const next = subSchema(node, segment);
    if (next === undefined) return undefined;
    node = next;
  }
  const values = node.enum;
  return Array.isArray(values) && values.every((value) => typeof value === "string")
    ? (values as string[])
    : undefined;
}

/** The sub-schema of `node` at `segment`: a property, an array's items, a record's values, or a union's branch. */
function subSchema(
  node: Record<string, unknown>,
  segment: string,
): Record<string, unknown> | undefined {
  const properties = node.properties;
  if (typeof properties === "object" && properties !== null) {
    const property = (properties as Record<string, unknown>)[segment];
    if (typeof property === "object" && property !== null)
      return property as Record<string, unknown>;
  }
  if (/^\d+$/.test(segment)) {
    const items = node.items;
    if (typeof items === "object" && items !== null) return items as Record<string, unknown>;
  }
  const values = node.additionalProperties;
  if (typeof values === "object" && values !== null) return values as Record<string, unknown>;
  const branches = node.anyOf;
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      if (typeof branch !== "object" || branch === null) continue;
      const found = subSchema(branch as Record<string, unknown>, segment);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ProblemError({ code: "too_large" });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProblemError({ code: "bad_json" });
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveUi(uiDir: string | undefined, pathname: string, response: ServerResponse) {
  if (uiDir === undefined) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      "The panel is not built yet. Run npm run build, or npm run web:dev for a development server.",
    );
    return;
  }
  const relative = pathname.replace(/^\/(ui\/?)?/, "") || "index.html";
  let file: string;
  try {
    file = resolveInside(uiDir, relative);
  } catch {
    throw new ProblemError({ code: "no_file" });
  }
  const data = await readFile(file).catch(() => readFile(join(uiDir, "index.html")));
  const type = MIME[extname(file)] ?? MIME[".html"] ?? "text/html";
  response.writeHead(200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:",
  });
  response.end(data);
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
