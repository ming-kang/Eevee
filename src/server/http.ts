import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { compile, type Schema, type Validator } from "@earendil-works/pi-schema";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type ProblemCode, ProblemError, problemOf } from "../domain/index.ts";
import { ROUTE_BODIES } from "../protocol/bodies.ts";
import {
  type ApiError,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteResponse,
  TOKEN_HEADER,
} from "../protocol/contract.ts";
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

type BodyCheck = { schema: Schema; check: Validator<unknown> };

export function createHttpServer(options: ServerOptions): Server {
  return createServer(getRequestListener(createApp(options).fetch));
}

type Env = { Bindings: HttpBindings };

/** The HTTP interface: loopback only, token-guarded routes with schema-checked bodies, and the built panel. */
export function createApp(options: ServerOptions): Hono<Env> {
  const bodies = new Map<string, BodyCheck>(
    Object.entries(ROUTE_BODIES).map(([key, schema]) => [key, { schema, check: compile(schema) }]),
  );
  const app = new Hono<Env>();
  app.onError((error) => problemResponse(error));
  app.notFound((c) =>
    problemResponse(new ProblemError({ code: "no_route", method: c.req.method, path: c.req.path })),
  );

  app.use(async (c, next) => {
    if (!isLoopbackRequest(c.env.incoming)) throw new ProblemError({ code: "forbidden_host" });
    await next();
  });

  const ui = (c: Context<Env>) => serveUi(options.uiDir, new URL(c.req.url).pathname);
  app.all("/", ui);
  app.all("/ui", ui);
  app.all("/ui/*", ui);

  const limit = bodyLimit({
    maxSize: MAX_BODY,
    onError: () => {
      throw new ProblemError({ code: "too_large" });
    },
  });
  for (const [key, definition] of Object.entries(options.routes)) {
    const [method, path] = key.split(" ") as [string, string];
    const route = definition as RouteDefinition<RouteKey>;
    const body = bodies.get(key);
    const guard: MiddlewareHandler<Env> = async (c, next) => {
      if (!route.public && !options.auth.verify(c.req.header(TOKEN_HEADER))) {
        throw new ProblemError({ code: "unauthorized" });
      }
      await next();
    };
    app.on(method, path, guard, limit, async (c) => {
      const value = parseBody(body, await readBody(c));
      // The route's own schema has checked the body; only the erased route type is left to cast.
      const context = { params: c.req.param(), body: value } as RouteContext<RouteKey>;
      return json(200, await route.handle(context));
    });
  }
  return app;
}

function problemResponse(error: unknown): Response {
  const problem = problemOf(error);
  if (problem.code === "internal") console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const payload: ApiError = { error: { ...problem, message } };
  return json(STATUS[problem.code], payload);
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

async function readBody(c: Context<Env>): Promise<unknown> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return undefined;
  const text = await c.req.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
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

async function serveUi(uiDir: string | undefined, pathname: string): Promise<Response> {
  if (uiDir === undefined) {
    return new Response(
      "The panel is not built yet. Run npm run build, or npm run web:dev for a development server.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
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
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:",
    },
  });
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
