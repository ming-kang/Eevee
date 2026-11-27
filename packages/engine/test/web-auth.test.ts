import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EeveeClient } from "@eevee/protocol";
import { startForegroundEngine } from "../src/index.ts";
import {
  isSameOriginRequest,
  WEB_SESSION_COOKIE,
  WEB_TICKET_TTL_MS,
  WebAuthManager,
} from "../src/web-auth.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-web-auth-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("WebAuthManager enforces one-time ticket redemption, expiry, and session revocation", () => {
  const auth = new WebAuthManager();
  const t0 = 1_700_000_000_000;
  const issued = auth.issueTicket(t0);
  assert.equal(issued.expiresAt, t0 + WEB_TICKET_TTL_MS);

  assert.equal(auth.redeemTicket(issued.ticket, t0 + 1_000), true);
  assert.equal(auth.redeemTicket(issued.ticket, t0 + 1_000), false);

  const expired = auth.issueTicket(t0);
  assert.equal(auth.redeemTicket(expired.ticket, t0 + WEB_TICKET_TTL_MS + 1), false);

  const session = auth.createSession(t0);
  const cookieHeader = `${WEB_SESSION_COOKIE}=${session.sessionId}`;
  assert.equal(auth.verifyCookieHeader(cookieHeader, t0 + 10_000), session.sessionId);
  auth.revokeCookieHeader(cookieHeader);
  assert.equal(auth.verifyCookieHeader(cookieHeader, t0 + 10_000), undefined);
});

test("HTTP server supports web ticket login, HttpOnly cookie auth, CSRF protection, and static SPA hosting", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const webDist = join(dir, "web-dist");
    const workspace = join(dir, "ws");
    await mkdir(join(webDist, "assets"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(webDist, "index.html"),
      "<!doctype html><html><body>EEVEE_SPA</body></html>",
    );
    await writeFile(join(webDist, "assets", "app.js"), "console.log('ok');\n");
    await writeFile(join(dir, "secret.txt"), "TOP_SECRET");

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      webDistDir: webDist,
      recoverProjects: false,
    });

    try {
      const indexRes = await fetch(`${foreground.url}/`);
      assert.equal(indexRes.status, 200);
      assert.match(indexRes.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await indexRes.text(), /EEVEE_SPA/);

      const assetRes = await fetch(`${foreground.url}/assets/app.js`);
      assert.equal(assetRes.status, 200);
      assert.match(assetRes.headers.get("cache-control") ?? "", /immutable/);

      const spaRes = await fetch(`${foreground.url}/projects/demo/workers/w1`, {
        headers: { Accept: "text/html" },
      });
      assert.equal(spaRes.status, 200);
      assert.match(await spaRes.text(), /EEVEE_SPA/);

      const traversalRes = await fetch(`${foreground.url}/%2e%2e/secret.txt`);
      assert.equal(traversalRes.status, 401);

      const bearerClient = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const api404Res = await fetch(`${foreground.url}/nonexistent-api`, {
        headers: { Authorization: `Bearer ${foreground.token}`, Accept: "application/json" },
      });
      assert.equal(api404Res.status, 404);

      const anonSession = await (await fetch(`${foreground.url}/auth/session`)).json();
      assert.deepEqual(anonSession, { authenticated: false });

      const crossOriginLogin = await fetch(`${foreground.url}/auth/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.example",
        },
        body: JSON.stringify({ token: foreground.token }),
      });
      assert.equal(crossOriginLogin.status, 403);

      const { ticket } = await bearerClient.createWebTicket();
      const loginRes = await fetch(`${foreground.url}/auth/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: foreground.url,
        },
        body: JSON.stringify({ ticket }),
      });
      assert.equal(loginRes.status, 200);
      const setCookie = loginRes.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /eevee_session=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      const cookiePair = setCookie.split(";")[0] ?? "";

      const replayRes = await fetch(`${foreground.url}/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: foreground.url },
        body: JSON.stringify({ ticket }),
      });
      assert.equal(replayRes.status, 401);

      const authedSession = await (
        await fetch(`${foreground.url}/auth/session`, { headers: { Cookie: cookiePair } })
      ).json();
      assert.deepEqual(authedSession, { authenticated: true });

      const cookieGet = await fetch(`${foreground.url}/projects`, {
        headers: { Cookie: cookiePair },
      });
      assert.equal(cookieGet.status, 200);

      const csrfPost = await fetch(`${foreground.url}/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          Origin: "http://evil.example",
        },
        body: JSON.stringify({ workspaces: [workspace], title: "CSRF" }),
      });
      assert.equal(csrfPost.status, 403);

      const validPost = await fetch(`${foreground.url}/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          Origin: foreground.url,
        },
        body: JSON.stringify({ workspaces: [workspace], title: "CookieProject" }),
      });
      assert.equal(validPost.status, 201);

      const sameSitePost = await fetch(`${foreground.url}/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          Origin: foreground.url,
          "Sec-Fetch-Site": "same-site",
        },
        body: JSON.stringify({ workspaces: [workspace], title: "SameSiteRejected" }),
      });
      assert.equal(sameSitePost.status, 403);

      const logoutRes = await fetch(`${foreground.url}/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookiePair, Origin: foreground.url },
      });
      assert.equal(logoutRes.status, 200);

      const afterLogout = await fetch(`${foreground.url}/projects`, {
        headers: { Cookie: cookiePair },
      });
      assert.equal(afterLogout.status, 401);
    } finally {
      await foreground.close();
    }
  });
});

test("isSameOriginRequest rejects sec-fetch-site same-site/cross-site while allowing same-origin and none", () => {
  const reqWith = (headers: Record<string, string | string[] | undefined>) =>
    ({ headers }) as unknown as IncomingMessage;

  assert.equal(
    isSameOriginRequest(
      reqWith({ "sec-fetch-site": "same-site", origin: "http://127.0.0.1:4173" }),
      4173,
    ),
    false,
  );
  assert.equal(
    isSameOriginRequest(
      reqWith({ "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:4173" }),
      4173,
    ),
    false,
  );
  assert.equal(
    isSameOriginRequest(
      reqWith({ "sec-fetch-site": "same-origin", origin: "http://evil.example" }),
      4173,
    ),
    false,
  );
  assert.equal(
    isSameOriginRequest(
      reqWith({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4173" }),
      4173,
    ),
    true,
  );
  assert.equal(isSameOriginRequest(reqWith({ "sec-fetch-site": "same-origin" }), 4173), true);
  assert.equal(
    isSameOriginRequest(
      reqWith({ "sec-fetch-site": "none", origin: "http://localhost:4173" }),
      4173,
    ),
    true,
  );
  assert.equal(isSameOriginRequest(reqWith({ "sec-fetch-site": "none" }), 4173), true);
});
