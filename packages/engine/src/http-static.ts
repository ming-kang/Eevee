import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export type StaticAssetHandler = {
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
};

export function resolveDefaultWebDistDir(): string | undefined {
  const candidate = resolve(fileURLToPath(new URL("../../../apps/web/dist", import.meta.url)));
  return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== "string") return false;
  return accept.includes("text/html");
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  cacheControl: string,
): Promise<void> {
  const content = await readFile(filePath);
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(content.length),
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(content);
}

export function createStaticAssetHandler(distDir: string): StaticAssetHandler {
  const root = resolve(distDir);
  const indexPath = join(root, "index.html");

  return {
    async serve(req, res, pathname): Promise<boolean> {
      if (req.method !== "GET" && req.method !== "HEAD") return false;

      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return false;
      }
      if (decoded.includes("\0")) return false;

      const relPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      const candidate = resolve(root, relPath);
      if (!insideRoot(root, candidate)) return false;

      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          const isImmutable = decoded.startsWith("/assets/");
          const cache = isImmutable ? "public, max-age=31536000, immutable" : "no-cache";
          await sendFile(req, res, candidate, cache);
          return true;
        }
      } catch {
        // Fall through to SPA index fallback for HTML navigation requests.
      }

      if (acceptsHtml(req) && extname(relPath) === "" && existsSync(indexPath)) {
        await sendFile(req, res, indexPath, "no-cache");
        return true;
      }

      return false;
    },
  };
}
