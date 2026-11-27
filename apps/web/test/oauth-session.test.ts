import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProviderOAuthEvent,
  createActiveProviderLogin,
  markProviderOAuthUnexpectedEnd,
} from "../src/components/settings/providers/useProviderOAuth.ts";
import {
  applyMcpOAuthEvent,
  createOAuthUiSession,
  markMcpOAuthUnexpectedEnd,
} from "../src/components/settings/useMcpOAuth.ts";

test("MCP OAuth session reducers transition events and ignore stale session IDs", () => {
  let session = applyMcpOAuthEvent(createOAuthUiSession("github", "s1"), "other", {
    type: "complete",
  });
  assert.ok(session);
  assert.equal(session.done, false);

  session = applyMcpOAuthEvent(session, "s1", {
    type: "auth_url",
    url: "https://auth.example.com/authorize",
    redirectUrl: "http://127.0.0.1:8080/callback",
    instructions: "Open browser",
  });
  assert.ok(session);
  assert.equal(session.authUrl, "https://auth.example.com/authorize");
  assert.equal(session.redirectHint, "http://127.0.0.1:8080/callback");
  assert.equal(session.instructions, "Open browser");

  session = applyMcpOAuthEvent(session, "s1", { type: "progress", message: "Exchanging token" });
  assert.ok(session);
  assert.equal(session.progress.length, 1);
  assert.equal(session.progress[0]?.message, "Exchanging token");

  const completed = applyMcpOAuthEvent(session, "s1", { type: "complete" });
  assert.equal(completed?.done, true);

  const errored = applyMcpOAuthEvent(session, "s1", {
    type: "error",
    code: "denied",
    message: "Access denied",
  });
  assert.equal(errored?.error, "Access denied");

  const interrupted = markMcpOAuthUnexpectedEnd(session, "s1");
  assert.equal(interrupted?.error, "OAuth 授权流意外中断");
  assert.equal(markMcpOAuthUnexpectedEnd(session, "other")?.error, undefined);
});

test("Provider OAuth login reducers transition events and clear prompt on terminal states", () => {
  let login = applyProviderOAuthEvent(createActiveProviderLogin("anthropic", "p1"), "stale", {
    type: "complete",
    complete: { providerId: "anthropic", type: "oauth" },
  });
  assert.ok(login);
  assert.equal(login.done, undefined);

  login = applyProviderOAuthEvent(login, "p1", {
    type: "auth",
    event: { type: "auth_url", url: "https://claude.ai/oauth", instructions: "Authorize" },
  });
  assert.ok(login);
  assert.equal(login.authEvents.length, 1);

  login = applyProviderOAuthEvent(login, "p1", {
    type: "prompt",
    prompt: { promptId: "code", type: "text", message: "Paste code" },
  });
  assert.ok(login);
  assert.equal(login.prompt?.promptId, "code");

  const completed = applyProviderOAuthEvent(login, "p1", {
    type: "complete",
    complete: { providerId: "anthropic", type: "oauth" },
  });
  assert.equal(completed?.prompt, undefined);
  assert.equal(completed?.done, "anthropic 已完成登录");

  const failed = applyProviderOAuthEvent(login, "p1", {
    type: "error",
    error: { code: "oauth_failed", message: "Invalid code" },
  });
  assert.equal(failed?.prompt, undefined);
  assert.equal(failed?.error, "Invalid code");

  const interrupted = markProviderOAuthUnexpectedEnd(login, "p1");
  assert.equal(interrupted?.prompt, undefined);
  assert.equal(interrupted?.error, "OAuth 授权流意外中断");
});
