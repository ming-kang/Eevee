import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ProblemError } from "../domain/index.ts";
import { TOKEN_HEADER } from "../protocol/contract.ts";
import { Auth } from "./auth.ts";
import { createHttpServer, type RouteTable } from "./http.ts";

let dir: string;
let token: string;
let port: number;
let server: Server;
let uiServer: Server;
let uiPort: number;
const seen: unknown[] = [];

const routes = {
  "GET /api/health": { handle: async () => ({ version: "test", bootId: "boot" }) },
  "POST /api/session": {
    handle: async ({ body }: { body: { code: string } }) => {
      seen.push(body);
      return { ok: true };
    },
  },
  "PUT /api/models/providers/:provider/credentials": {
    handle: async ({ params, body }: { params: { provider: string }; body: unknown }) => {
      seen.push({ params, body });
      return { ok: true };
    },
  },
  "GET /api/engine": {
    handle: async () => {
      throw new ProblemError({ code: "no_project", projectId: "p1" });
    },
  },
} as unknown as RouteTable;

type Reply = { status: number; headers: Record<string, unknown>; body: string };

function send(
  target: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: target, method, path, headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const call = (method: string, path: string, options?: Parameters<typeof send>[3]) =>
  send(port, method, path, options);
const errorCode = (reply: Reply) => (JSON.parse(reply.body) as { code: string }).code;

async function start(uiDir: string | undefined): Promise<[Server, number]> {
  const auth = new Auth({ token: "test-token" });
  const created = createHttpServer({ routes, auth, uiDir });
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return [created, (created.address() as AddressInfo).port];
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-http-"));
  await mkdir(join(dir, "ui", "assets"), { recursive: true });
  await writeFile(join(dir, "ui", "index.html"), "<p>panel</p>");
  await writeFile(join(dir, "ui", "assets", "app.js"), "console.log(1)");
  [server, port] = await start(undefined);
  [uiServer, uiPort] = await start(join(dir, "ui"));
  token = "test-token";
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => uiServer.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test("a public route answers JSON without the token", async () => {
  const reply = await call("GET", "/api/health");
  assert.equal(reply.status, 200);
  assert.match(String(reply.headers["content-type"]), /application\/json/);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(reply.body), { version: "test", bootId: "boot" });
});

test("a guarded route needs the token and gets decoded params and the checked body", async () => {
  const unauthorized = await call("PUT", "/api/models/providers/open%20ai/credentials", {
    body: '{"key":"k"}',
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(errorCode(unauthorized), "unauthorized");

  const reply = await call("PUT", "/api/models/providers/open%20ai/credentials", {
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    body: '{"key":"k"}',
  });
  assert.equal(reply.status, 204);
  assert.equal(reply.body, "");
  assert.deepEqual(seen.at(-1), { params: { provider: "open ai" }, body: { key: "k" } });
});

test("a request from a foreign host or origin is refused", async () => {
  const host = await call("GET", "/api/health", { headers: { host: "evil.example" } });
  assert.equal(host.status, 403);
  assert.equal(errorCode(host), "forbidden_host");
  const origin = await call("GET", "/api/health", { headers: { origin: "https://evil.example" } });
  assert.equal(origin.status, 403);
});

test("an unknown path or method is no_route", async () => {
  const path = await call("GET", "/api/nothing");
  assert.equal(path.status, 404);
  assert.deepEqual(JSON.parse(path.body), {
    code: "no_route",
    method: "GET",
    path: "/api/nothing",
    title: JSON.parse(path.body).title,
    status: 404,
  });
  assert.equal((await call("DELETE", "/api/health")).status, 404);
});

test("bodies are parsed, schema-checked and size-limited", async () => {
  const missing = await call("POST", "/api/session");
  assert.equal(missing.status, 400);
  assert.deepEqual(
    { code: errorCode(missing), field: JSON.parse(missing.body).field },
    { code: "required", field: "code" },
  );
  const wrongType = await call("POST", "/api/session", { body: '{"code":1}' });
  assert.equal(errorCode(wrongType), "invalid");
  const badJson = await call("POST", "/api/session", { body: "{" });
  assert.equal(badJson.status, 400);
  assert.equal(errorCode(badJson), "bad_json");
  const huge = await call("POST", "/api/session", {
    body: JSON.stringify({ code: "x".repeat(1024 * 1024) }),
  });
  assert.equal(huge.status, 413);
  assert.equal(errorCode(huge), "too_large");
});

test("a handler's problem keeps its code and status", async () => {
  const reply = await call("GET", "/api/engine", { headers: { [TOKEN_HEADER]: token } });
  assert.equal(reply.status, 404);
  assert.equal(errorCode(reply), "no_project");
});

test("the panel is served from its directory, falling back to index.html", async () => {
  assert.equal((await call("GET", "/ui/")).status, 503);

  const index = await send(uiPort, "GET", "/ui/");
  assert.equal(index.status, 200);
  assert.equal(index.body, "<p>panel</p>");
  assert.match(String(index.headers["content-security-policy"]), /default-src 'self'/);
  assert.equal(index.headers["x-content-type-options"], "nosniff");

  const asset = await send(uiPort, "GET", "/ui/assets/app.js");
  assert.match(String(asset.headers["content-type"]), /text\/javascript/);
  assert.equal(asset.body, "console.log(1)");

  assert.equal((await send(uiPort, "GET", "/ui/settings/general")).body, "<p>panel</p>");
  assert.equal((await send(uiPort, "GET", "/")).body, "<p>panel</p>");
});
