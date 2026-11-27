import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CreateWebSessionRequestSchema } from "@eevee/protocol";
import { verifyBearerToken } from "./auth.ts";
import { createDirectoryPicker, type DirectoryPicker } from "./directory-picker.ts";
import { type Engine, EngineError } from "./engine.ts";
import { toEngineError } from "./engine-error.ts";
import {
  parsePathParams,
  RouteTrie,
  readBody,
  readOptionalJsonBody,
  sendJson,
  sendMethodNotAllowed,
  sendProblem,
} from "./http-io.ts";
import { createEngineRoutes } from "./http-routes.ts";
import { createSseStreamHandlers } from "./http-sse.ts";
import {
  createStaticAssetHandler,
  resolveDefaultWebDistDir,
  type StaticAssetHandler,
} from "./http-static.ts";
import { isSameOriginRequest, WebAuthManager } from "./web-auth.ts";

export type EngineHttpServerOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly token: string;
  readonly webDistDir?: string | false;
  readonly onShutdown?: () => void;
  readonly directoryPicker?: DirectoryPicker;
};

export type EngineHttpServer = {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

export async function startEngineHttpServer(
  engine: Engine,
  options: EngineHttpServerOptions,
): Promise<EngineHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error(`Engine HTTP server only binds to 127.0.0.1 (refused host "${host}")`);
  }
  const requestedPort = options.port ?? 0;
  const activeClosers = new Set<() => Promise<void>>();
  let closing = false;
  let boundPort = requestedPort;

  const webAuth = new WebAuthManager();
  const directoryPicker = options.directoryPicker ?? createDirectoryPicker();
  const resolvedWebDist =
    options.webDistDir === false ? undefined : (options.webDistDir ?? resolveDefaultWebDistDir());
  const staticHandler: StaticAssetHandler | undefined =
    resolvedWebDist === undefined ? undefined : createStaticAssetHandler(resolvedWebDist);

  const streams = createSseStreamHandlers({
    engine,
    isClosing: () => closing,
    trackCloser: (closer) => {
      activeClosers.add(closer);
      return () => activeClosers.delete(closer);
    },
  });

  const routeTrie = new RouteTrie(
    createEngineRoutes(engine, {
      streams,
      webAuth,
      directoryPicker,
      ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
    }),
  );

  function isAuthenticatedRequest(req: IncomingMessage): "bearer" | "cookie" | undefined {
    if (verifyBearerToken(req.headers.authorization, options.token)) return "bearer";
    if (webAuth.verifyCookieHeader(req.headers.cookie) !== undefined) return "cookie";
    return undefined;
  }

  async function handlePublicAuthRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    pathname: string,
  ): Promise<boolean> {
    if (pathname === "/auth/session") {
      if (method === "GET") {
        sendJson(res, 200, { authenticated: isAuthenticatedRequest(req) !== undefined });
        return true;
      }
      if (method === "POST") {
        if (!isSameOriginRequest(req, boundPort)) {
          sendProblem(res, 403, {
            code: "csrf_rejected",
            message: "Cross-origin request rejected",
          });
          return true;
        }
        const input = await readBody(req, CreateWebSessionRequestSchema, "CreateWebSessionRequest");
        const valid =
          (input.ticket !== undefined && webAuth.redeemTicket(input.ticket)) ||
          (input.token !== undefined && verifyBearerToken(`Bearer ${input.token}`, options.token));
        if (!valid) {
          sendProblem(res, 401, { code: "unauthorized", message: "Invalid token or login ticket" });
          return true;
        }
        const session = webAuth.createSession();
        sendJson(res, 200, { authenticated: true }, { "Set-Cookie": session.cookieHeader });
        return true;
      }
      sendMethodNotAllowed(res, method, "GET, POST");
      return true;
    }

    if (pathname === "/auth/logout") {
      if (method !== "POST") {
        sendMethodNotAllowed(res, method, "POST");
        return true;
      }
      if (!isSameOriginRequest(req, boundPort)) {
        sendProblem(res, 403, { code: "csrf_rejected", message: "Cross-origin request rejected" });
        return true;
      }
      await readOptionalJsonBody(req);
      webAuth.revokeCookieHeader(req.headers.cookie);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": webAuth.clearCookieHeader() });
      return true;
    }

    return false;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) {
      sendProblem(res, 503, { code: "engine_closed", message: "Engine is closing" });
      return;
    }

    let url: URL;
    let segments: string[];
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
      segments = url.pathname
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponent(part));
    } catch (error) {
      sendProblem(res, 400, {
        code: "invalid_url",
        message: "Malformed request URL",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const method = req.method ?? "GET";

    try {
      if (await handlePublicAuthRoute(req, res, method, url.pathname)) return;

      const routeMatch = routeTrie.matchPath(segments);
      if (routeMatch === undefined) {
        if (staticHandler !== undefined && (method === "GET" || method === "HEAD")) {
          if (await staticHandler.serve(req, res, url.pathname)) return;
        }
        const authKind = isAuthenticatedRequest(req);
        if (authKind === undefined) {
          sendProblem(
            res,
            401,
            { code: "unauthorized", message: "Missing or invalid bearer token" },
            { "WWW-Authenticate": "Bearer" },
          );
          return;
        }
        sendProblem(res, 404, { code: "not_found", message: "Route not found" });
        return;
      }

      const authKind = isAuthenticatedRequest(req);
      if (authKind === undefined) {
        sendProblem(
          res,
          401,
          { code: "unauthorized", message: "Missing or invalid bearer token" },
          { "WWW-Authenticate": "Bearer" },
        );
        return;
      }
      if (authKind === "cookie" && method !== "GET" && method !== "HEAD") {
        if (!isSameOriginRequest(req, boundPort)) {
          sendProblem(res, 403, {
            code: "csrf_rejected",
            message: "Cross-origin request rejected",
          });
          return;
        }
      }

      const matched = routeMatch.methods.get(method);
      if (matched === undefined) {
        sendMethodNotAllowed(res, method, routeMatch.allowHeader);
        return;
      }
      const params = parsePathParams(matched.pattern, segments);
      await matched.handle({ req, res, url, params });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      if (error instanceof EngineError) {
        const extra = error.code === "payload_too_large" ? { Connection: "close" } : undefined;
        sendProblem(res, error.status, error.toProblem(), extra);
        return;
      }
      const mapped = toEngineError(error);
      if (mapped instanceof EngineError) {
        sendProblem(res, mapped.status, mapped.toProblem());
        return;
      }
      sendProblem(res, 500, {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Expected TCP address for Engine HTTP server");
  }
  boundPort = address.port;
  const url = `http://${host}:${boundPort}`;

  let closePromise: Promise<void> | undefined;
  return {
    server,
    host,
    port: boundPort,
    url,
    close: () => {
      closePromise ??= (async () => {
        closing = true;
        await Promise.allSettled([...activeClosers].map((closeStream) => closeStream()));
        server.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined && error !== null) reject(error);
            else resolve();
          });
        });
      })();
      return closePromise;
    },
  };
}
