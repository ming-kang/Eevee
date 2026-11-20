import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAuthCode, formatRoute, parseRoute, type Route, resolveRoute } from "./router.ts";

test("every route parses and formats and round-trips", () => {
  const routes: Route[] = [
    { name: "chat", pid: "optics" },
    { name: "chat", pid: "optics", qid: "q4" },
    { name: "worker", pid: "optics", tid: "t5" },
    { name: "memory", pid: "optics" },
    { name: "usage", pid: "optics" },
    { name: "settings", section: "general" },
    { name: "settings", section: "models" },
    { name: "settings", section: "roles" },
    { name: "settings", section: "mcp" },
    { name: "settings", section: "engine" },
    { name: "settings", section: "models", item: "my gw" },
    { name: "settings", section: "mcp", item: "+" },
    { name: "connect" },
  ];
  for (const route of routes) {
    const hash = formatRoute(route);
    assert.deepEqual(parseRoute(hash), route);
  }
});

test("encoded project and ticket ids are supported", () => {
  const route: Route = { name: "worker", pid: "proj a/b", tid: "t12" };
  const hash = formatRoute(route);
  assert.equal(hash, "#/p/proj%20a%2Fb/t/t12");
  assert.deepEqual(parseRoute(hash), route);
});

test("a Home question link preserves its target when opening or reloading a project", () => {
  const route: Route = { name: "chat", pid: "proj a/b", qid: "q2" };
  const hash = "#/p/proj%20a%2Fb/q/q2";
  assert.equal(formatRoute(route), hash);
  assert.deepEqual(parseRoute(hash), route);
  assert.deepEqual(resolveRoute(hash, "another-project"), route);
  for (const invalid of ["#/p/optics/q/nope", "#/p/optics/q/%E0%A4", "#/p/optics/q/q2/extra"]) {
    assert.equal(parseRoute(invalid), undefined);
  }
});

test("settings defaults to general when the sub-page is missing or unknown", () => {
  assert.deepEqual(parseRoute("#/settings"), { name: "settings", section: "general" });
  assert.deepEqual(parseRoute("#/settings/unknown"), { name: "settings", section: "general" });
  assert.deepEqual(parseRoute("#/settings/general/x"), { name: "settings", section: "general" });
  assert.deepEqual(parseRoute("#/settings/models/openai"), {
    name: "settings",
    section: "models",
    item: "openai",
  });
});

test("an empty hash, unknown paths and #code= are not treated as routes", () => {
  assert.equal(parseRoute(""), undefined);
  assert.equal(parseRoute("#"), undefined);
  assert.equal(parseRoute("#/"), undefined);
  assert.equal(parseRoute("#/unknown/path"), undefined);
  assert.equal(parseRoute("#/p/optics/extra"), undefined);
  assert.equal(parseRoute("#code=secret123"), undefined);
});

test("resolveRoute sends an empty hash home and an unknown path to the fallback project", () => {
  assert.deepEqual(resolveRoute("", "p1"), { name: "home" });
  assert.deepEqual(resolveRoute("#", "p1"), { name: "home" });
  assert.deepEqual(resolveRoute("#/", "p1"), { name: "home" });
  assert.deepEqual(resolveRoute("#/unknown", "p1"), { name: "chat", pid: "p1" });
  assert.deepEqual(resolveRoute("", undefined), { name: "home" });
  assert.deepEqual(resolveRoute("#/settings/mcp", undefined), {
    name: "settings",
    section: "mcp",
  });
});

test("extractAuthCode reads the one-time code without disturbing normal routes", () => {
  assert.equal(extractAuthCode("#code=abc%2B123"), "abc+123");
  assert.equal(extractAuthCode("#?code=xyz"), "xyz");
  assert.equal(extractAuthCode("#code="), undefined);
  assert.equal(extractAuthCode("#/p/optics"), undefined);
  assert.equal(extractAuthCode(""), undefined);
});
