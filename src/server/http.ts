import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import {
  type ApiError,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteResponse,
  TOKEN_HEADER,
} from "../api/contract.ts";
import { resolveInside } from "../shared/paths.ts";
import { type Auth, type Caller, isLoopbackRequest } from "./auth.ts";

export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type RouteContext<K extends RouteKey> = {
  params: RouteParams<K>;
  body: RouteBody<K>;
  caller: Caller | undefined;
};

export type RouteDefinition<K extends RouteKey> = {
  public?: boolean;
  cliOnly?: boolean;
  handle(context: RouteContext<K>): Promise<RouteResponse<K>>;
};

export type RouteTable = { [K in RouteKey]: RouteDefinition<K> };

export type ServerOptions = {
  routes: RouteTable;
  auth: Auth;
  uiDir: string | undefined;
};

const MAX_BODY = 1024 * 1024;

export function createHttpServer(options: ServerOptions): Server {
  const compiled = Object.entries(options.routes).map(([key, definition]) => {
    const [method, template] = key.split(" ") as [string, string];
    const names: string[] = [];
    const pattern = new RegExp(
      `^${template.replace(/:([a-z]+)/g, (_, name: string) => {
        names.push(name);
        return "([^/]+)";
      })}$`,
    );
    return { method, pattern, names, definition: definition as RouteDefinition<RouteKey> };
  });

  return createServer(async (request, response) => {
    try {
      if (!isLoopbackRequest(request)) throw new HttpError(403, "forbidden_host", "只接受本机请求");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname.startsWith("/ui")) {
        return await serveUi(options.uiDir, url.pathname, response);
      }
      const route = compiled.find(
        (r) => r.method === request.method && r.pattern.test(url.pathname),
      );
      if (route === undefined)
        throw new HttpError(404, "not_found", `没有接口 ${request.method} ${url.pathname}`);

      const caller = options.auth.verify(header(request, TOKEN_HEADER));
      if (!route.definition.public && caller === undefined) {
        throw new HttpError(401, "unauthorized", "需要授权，请用 eevee web 打开面板");
      }
      if (route.definition.cliOnly && caller !== "cli") {
        throw new HttpError(403, "cli_only", "只允许 CLI 调用");
      }
      const match = route.pattern.exec(url.pathname) ?? [];
      const params = Object.fromEntries(
        route.names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? "")]),
      );
      const body = await readBody(request);
      const result = await route.definition.handle({
        params,
        body,
        caller,
      } as RouteContext<RouteKey>);
      sendJson(response, 200, result);
    } catch (error) {
      const known = error instanceof HttpError ? error : fromDomainError(error);
      if (!known) console.error(error);
      const payload: ApiError = {
        error: {
          code: known?.code ?? "internal",
          message: known?.message ?? (error instanceof Error ? error.message : String(error)),
        },
      };
      sendJson(response, known?.status ?? 500, payload);
    }
  });
}

const DOMAIN_ERRORS: Record<string, [number, string]> = {
  NotFound: [404, "not_found"],
  Conflict: [409, "conflict"],
  NoModelConfigured: [409, "no_model"],
  UnknownModel: [404, "unknown_model"],
};

function fromDomainError(error: unknown): HttpError | undefined {
  if (!(error instanceof Error)) return undefined;
  const mapped = DOMAIN_ERRORS[error.name];
  return mapped === undefined ? undefined : new HttpError(mapped[0], mapped[1], error.message);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "请求体不是合法的 JSON");
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
    response.end("WebUI 尚未构建：运行 npm run build，或用 npm run web:dev 启动开发服务器。");
    return;
  }
  const relative = pathname.replace(/^\/(ui\/?)?/, "") || "index.html";
  let file: string;
  try {
    file = resolveInside(uiDir, relative);
  } catch {
    throw new HttpError(404, "not_found", "没有这个文件");
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
