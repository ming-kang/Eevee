import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import {
  createEeveeMcpAuthProvider,
  createMcpHub,
  McpOAuthCredentialStore,
  McpOAuthSessionError,
  type McpOAuthSignInEvent,
  McpRefreshLockBusyError,
  mcpOAuthStoreKey,
  startMcpOAuthSignIn,
} from "../src/extensions/mcp/index.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

type MockOAuthServer = {
  readonly baseUrl: string;
  readonly mcpUrl: string;
  readonly registeredClients: Record<string, unknown>[];
  readonly tokenRequests: string[];
  close(): Promise<void>;
};

async function startMockOAuthMcpServer(): Promise<MockOAuthServer> {
  const registeredClients: Record<string, unknown>[] = [];
  const tokenRequests: string[] = [];
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; codeChallenge: string; scope?: string }
  >();
  const validTokens = new Set<string>();
  const refreshTokens = new Map<string, string>();
  let seq = 0;

  let baseUrl = "";
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", baseUrl);
    if (req.method === "GET" && reqUrl.pathname === "/.well-known/oauth-protected-resource") {
      sendJson(res, 200, {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["mcp:read"],
      });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/register") {
      const payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
      registeredClients.push(payload);
      const clientId = `client-${++seq}`;
      sendJson(res, 201, {
        client_id: clientId,
        redirect_uris: payload.redirect_uris ?? [],
        client_name: payload.client_name,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/authorize") {
      const clientId = reqUrl.searchParams.get("client_id") ?? "";
      const redirectUri = reqUrl.searchParams.get("redirect_uri") ?? "";
      const state = reqUrl.searchParams.get("state") ?? "";
      const codeChallenge = reqUrl.searchParams.get("code_challenge") ?? "";
      const method = reqUrl.searchParams.get("code_challenge_method") ?? "";
      const scope = reqUrl.searchParams.get("scope") ?? undefined;
      if (!clientId || !redirectUri || !codeChallenge || method !== "S256") {
        sendJson(res, 400, { error: "invalid_request" });
        return;
      }
      const code = `auth-code-${++seq}`;
      codes.set(code, { clientId, redirectUri, codeChallenge, scope });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      target.searchParams.set("iss", baseUrl);
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/token") {
      const params = new URLSearchParams(await readBody(req));
      const grantType = params.get("grant_type");
      tokenRequests.push(grantType ?? "");
      if (grantType === "authorization_code") {
        const code = params.get("code") ?? "";
        const verifier = params.get("code_verifier") ?? "";
        const redirectUri = params.get("redirect_uri") ?? "";
        const saved = codes.get(code);
        if (!saved) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        codes.delete(code);
        const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
        if (expectedChallenge !== saved.codeChallenge || redirectUri !== saved.redirectUri) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
          return;
        }
        const accessToken = `access-${++seq}`;
        const refreshToken = `refresh-${++seq}`;
        validTokens.add(accessToken);
        refreshTokens.set(refreshToken, saved.clientId);
        sendJson(res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refreshToken,
          ...(saved.scope ? { scope: saved.scope } : {}),
        });
        return;
      }
      if (grantType === "refresh_token") {
        const oldRefresh = params.get("refresh_token") ?? "";
        const clientId = refreshTokens.get(oldRefresh);
        if (!clientId) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        refreshTokens.delete(oldRefresh);
        const accessToken = `access-refreshed-${++seq}`;
        const nextRefresh = `refresh-rotated-${++seq}`;
        validTokens.add(accessToken);
        refreshTokens.set(nextRefresh, clientId);
        sendJson(res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: nextRefresh,
        });
        return;
      }
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (reqUrl.pathname === "/mcp") {
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      const authHeader = req.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!validTokens.has(token)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp:read"`,
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const msg = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (!("id" in msg)) {
        res.writeHead(202);
        res.end();
        return;
      }
      const id = msg.id;
      const method = msg.method;
      if (method === "initialize") {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "mock-oauth-mcp", version: "1.0.0" },
          },
        });
        return;
      }
      if (method === "tools/list") {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "whoami",
                description: "Verify authenticated tool call",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }
      if (method === "tools/call") {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `authed:${token}` }] },
        });
        return;
      }
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Expected TCP address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    registeredClients,
    tokenRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test("McpOAuthCredentialStore persists keyed credentials with 0600 mode, summaries, removal, and per-server refresh locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-mcp-oauth-store-"));
  try {
    const store = new McpOAuthCredentialStore(dir, { refreshLockTimeoutMs: 60 });
    const urlA = "https://alpha.example.com/mcp";
    const urlB = "https://beta.example.com/mcp";

    assert.equal(mcpOAuthStoreKey("my-srv", urlA), "mcp__my_srv|https://alpha.example.com/mcp");
    assert.equal(await store.hasTokens("my-srv", urlA), false);
    assert.deepEqual(await store.getTokenSummary("my-srv", urlA), { hasTokens: false });

    const serverA = store.forServer("my-srv", urlA);
    const serverB = store.forServer("other-srv", urlB);
    const expiresAt = Date.now() + 60_000;
    await serverA.save({
      serverUrl: urlA,
      tokens: { access_token: "tok-a", token_type: "Bearer", refresh_token: "ref-a" },
      tokensExpireAt: expiresAt,
    });
    await serverB.save({
      serverUrl: urlB,
      tokens: { access_token: "tok-b", token_type: "Bearer" },
    });

    assert.equal(await store.hasTokens("my-srv", urlA), true);
    assert.deepEqual(await store.getTokenSummary("my-srv", urlA), {
      hasTokens: true,
      expiresAt,
    });

    if (process.platform !== "win32") {
      const info = await stat(store.filePath);
      assert.equal(info.mode & 0o777, 0o600);
    }

    // Holding server A's refresh lock rejects concurrent A refresh with McpRefreshLockBusyError
    // while allowing server B's refresh lock to proceed immediately.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const held = serverA.withRefreshLock(async () => {
      const bResult = await serverB.withRefreshLock(async () => "b-ok");
      assert.equal(bResult, "b-ok");
      await assert.rejects(
        serverA.withRefreshLock(async () => "should-not-run"),
        McpRefreshLockBusyError,
      );
      await gateA;
    });
    releaseA();
    await held;

    assert.equal(await store.remove("my-srv", urlA), true);
    assert.equal(await store.remove("my-srv", urlA), false);
    assert.equal(await store.hasTokens("my-srv", urlA), false);
    assert.equal(await store.hasTokens("other-srv", urlB), true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("McpHub transitions to auth_required on 401 and connects after interactive PKCE loopback sign-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-mcp-oauth-loopback-"));
  const mock = await startMockOAuthMcpServer();
  const store = new McpOAuthCredentialStore(dir);
  const challenges: string[] = [];
  const hub = createMcpHub({
    servers: [
      {
        name: "authed",
        config: { type: "http", url: mock.mcpUrl, exposure: "direct" },
      },
    ],
    oauthStore: store,
    onAuthChallenge: (name) => challenges.push(name),
  });

  try {
    await hub.start();
    const initialSnap = hub.status()[0];
    assert.equal(initialSnap?.status, "auth_required");
    assert.equal(initialSnap?.authRequired, true);
    assert.equal(challenges.includes("authed"), true);
    assert.equal(hub.getAuthChallenge("authed")?.scope, "mcp:read");

    const events: McpOAuthSignInEvent[] = [];
    const session = startMcpOAuthSignIn({
      name: "authed",
      serverUrl: mock.mcpUrl,
      store,
      challenge: hub.getAuthChallenge("authed"),
    });
    session.subscribe((evt) => events.push(evt));

    const authUrl = await session.waitForAuthUrl();
    assert.ok(authUrl);
    const parsedAuth = new URL(authUrl);
    assert.equal(parsedAuth.searchParams.get("code_challenge_method"), "S256");

    // Simulate user completing browser flow which redirects to the local loopback server.
    const browserRes = await fetch(authUrl, { redirect: "follow" });
    assert.equal(browserRes.status, 200);
    await session.done;

    assert.equal(
      events.some((e) => e.type === "auth_url"),
      true,
    );
    assert.equal(events.at(-1)?.type, "complete");
    assert.equal(mock.registeredClients[0]?.client_name, "eevee");
    assert.equal(await store.hasTokens("authed", mock.mcpUrl), true);

    const after = await hub.reconnect("authed");
    const connected = after.find((s) => s.name === "authed");
    assert.equal(connected?.status, "connected");
    assert.equal(connected?.authRequired, undefined);
    assert.equal(connected?.toolCount, 1);

    const ext = hub.serverExtensions()[0];
    const whoami = ext?.tools?.find((t) => t.name === "mcp__authed__whoami");
    assert.ok(whoami);
    const result = await whoami.execute({}, {} as never, {} as never);
    assert.equal("isError" in result ? result.isError : undefined, undefined);
  } finally {
    await hub.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("startMcpOAuthSignIn supports manual redirect URL submission, cancellation, and automatic token refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-mcp-oauth-manual-"));
  const mock = await startMockOAuthMcpServer();
  const store = new McpOAuthCredentialStore(dir);

  try {
    // Manual redirect flow (no loopback HTTP server)
    const session = startMcpOAuthSignIn({
      name: "manual",
      serverUrl: mock.mcpUrl,
      store,
      loopback: false,
      redirectUrl: "http://127.0.0.1:41999/callback",
    });

    assert.throws(
      () => session.submitRedirectUrl("http://127.0.0.1:41999/callback?code=x&state=y"),
      (err: unknown) =>
        err instanceof McpOAuthSessionError &&
        err.code === "not_waiting" &&
        /not waiting/.test(err.message),
    );

    const authUrl = await session.waitForAuthUrl();
    assert.ok(authUrl);

    assert.throws(
      () => session.submitRedirectUrl("http://evil.example/callback?code=x&state=y"),
      (err: unknown) =>
        err instanceof McpOAuthSessionError &&
        err.code === "invalid_redirect" &&
        /does not match/.test(err.message),
    );

    const authRedirect = await fetch(authUrl, { redirect: "manual" });
    assert.equal(authRedirect.status, 302);
    const location = authRedirect.headers.get("location");
    assert.ok(location);

    session.submitRedirectUrl(location);
    await session.done;
    assert.equal(await store.hasTokens("manual", mock.mcpUrl), true);

    assert.throws(
      () => session.submitRedirectUrl(location),
      (err: unknown) =>
        err instanceof McpOAuthSessionError &&
        err.code === "session_closed" &&
        /has ended/.test(err.message),
    );

    // Simulate near-expiry token and verify createEeveeMcpAuthProvider refreshes via refresh_token
    const serverStore = store.forServer("manual", mock.mcpUrl);
    const saved = await serverStore.load();
    assert.ok(saved?.tokens?.refresh_token);
    await serverStore.save({
      ...saved,
      tokensExpireAt: Date.now() - 5_000,
    });

    const provider = createEeveeMcpAuthProvider({
      name: "manual",
      serverUrl: mock.mcpUrl,
      store,
    });
    const refreshedToken = await provider.token();
    assert.ok(refreshedToken?.startsWith("access-refreshed-"));
    assert.equal(mock.tokenRequests.includes("refresh_token"), true);
    await provider.settled();

    // Cancellation flow
    await store.remove("manual", mock.mcpUrl);
    const cancelledEvents: McpOAuthSignInEvent[] = [];
    const cancelled = startMcpOAuthSignIn({
      name: "manual",
      serverUrl: mock.mcpUrl,
      store,
      onEvent: (evt) => cancelledEvents.push(evt),
    });
    await cancelled.waitForAuthUrl();
    cancelled.cancel();
    await cancelled.done;
    assert.deepEqual(cancelledEvents.at(-1), {
      type: "error",
      code: "login_cancelled",
      message: "Sign-in cancelled",
    });
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
