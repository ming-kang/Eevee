import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { ApiRequestError, createClient } from "./client.ts";
import { PARAMS, ROUTES, TOKEN_HEADER } from "./contract.ts";

test("the route table declares every path param and validates ticket, scope and numeric ids", () => {
  assert.equal(new Set(ROUTES.map((route) => route.key)).size, ROUTES.length);
  for (const route of ROUTES) {
    assert.deepEqual(
      Object.keys(route.params).sort(),
      [...route.path.matchAll(/:([a-z]+)/g)].map((match) => match[1]).sort(),
      route.key,
    );
  }
  for (const [parameter, good, bad] of [
    [PARAMS.ticket, "t1", ["t0", "t01", "t-1", "router"]],
    [PARAMS.conversation, "router", ["t0", "t01", "other"]],
    [PARAMS.scope, "global", ["team", ""]],
    [PARAMS.job, "j1", ["j0", "job"]],
    [PARAMS.question, "q1", ["q0", "question"]],
    [PARAMS.project, "p123abcd", ["../project", "", "project/one"]],
  ] as const) {
    const validator = compile(parameter.schema);
    assert.equal(validator.validate(good).ok, true);
    for (const value of bad) assert.equal(validator.validate(value).ok, false, value);
  }
  assert.equal(PARAMS.change.parse("12"), 12);
  assert.throws(() => PARAMS.change.parse("9007199254740992"), {
    problem: { code: "invalid", field: "change" },
  });
});

test("the client encodes params, derives methods and returns undefined for 204", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const client = createClient({
    baseUrl: "http://localhost",
    token: "test-token",
    fetch: async (url, init) => {
      seen = { url: String(url), ...(init === undefined ? {} : { init }) };
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(
    await client.call(
      "DELETE /api/projects/:project/conversations/:conversation/queue/:submission",
      {
        project: "p1",
        conversation: "t1",
        submission: "2",
      },
    ),
    undefined,
  );
  assert.equal(seen?.url, "http://localhost/api/projects/p1/conversations/t1/queue/2");
  assert.equal(seen?.init?.method, "DELETE");
  assert.equal(new Headers(seen?.init?.headers).get(TOKEN_HEADER), "test-token");
  await client.call("GET /api/memory/files/:file", { file: "topics/a note.md" });
  assert.equal(seen?.url, "http://localhost/api/memory/files/topics%2Fa%20note.md");
});

test("the client reads top-level problem details and tolerates non-JSON errors", async () => {
  const body = {
    status: 400,
    title: "conversation is not valid",
    code: "invalid",
    field: "conversation",
  };
  const client = createClient({
    baseUrl: "http://localhost",
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status: 400,
        headers: { "content-type": "application/problem+json" },
      }),
  });
  await assert.rejects(client.call("GET /api/health"), (error: unknown) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.message, body.title);
    assert.deepEqual(error.body, body);
    assert.deepEqual(error.problem, { code: "invalid", field: "conversation" });
    return true;
  });
  const broken = createClient({
    baseUrl: "http://localhost",
    fetch: async () => new Response("unavailable", { status: 502, statusText: "Bad Gateway" }),
  });
  await assert.rejects(broken.call("GET /api/health"), {
    status: 502,
    problem: { code: "internal", detail: "Bad Gateway" },
  });
});
