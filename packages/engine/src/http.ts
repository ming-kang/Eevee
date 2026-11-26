import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SchemaValidationError } from "@eevee/protocol";
import { verifyBearerToken } from "./auth.ts";
import { type Engine, EngineError } from "./engine.ts";
import { matchesPattern, parsePathParams, sendMethodNotAllowed, sendProblem } from "./http-io.ts";
import { createEngineRoutes } from "./http-routes.ts";
import { createSseStreamHandlers } from "./http-sse.ts";

export type EngineHttpServerOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly token: string;
  readonly onShutdown?: () => void;
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

  const streams = createSseStreamHandlers({
    engine,
    isClosing: () => closing,
    trackCloser: (closer) => {
      activeClosers.add(closer);
      return () => activeClosers.delete(closer);
    },
  });

  const routes = createEngineRoutes(engine, {
    streams,
    ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!verifyBearerToken(req.headers.authorization, options.token)) {
      sendProblem(
        res,
        401,
        { code: "unauthorized", message: "Missing or invalid bearer token" },
        { "WWW-Authenticate": "Bearer" },
      );
      return;
    }

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
      const candidates = routes.filter((candidate) => matchesPattern(candidate.pattern, segments));
      const matched = candidates.find((candidate) => candidate.method === method);
      if (matched === undefined) {
        if (candidates.length === 0) {
          sendProblem(res, 404, { code: "not_found", message: "Route not found" });
        } else {
          sendMethodNotAllowed(res, method, candidates.map((c) => c.method).join(", "));
        }
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
      if (error instanceof SchemaValidationError) {
        sendProblem(res, 400, {
          code: "invalid_request",
          message: error.message,
        });
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
  const boundPort = address.port;
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
