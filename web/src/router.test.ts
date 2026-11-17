import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAuthCode, formatRoute, parseRoute, type Route, resolveRoute } from "./router.ts";

test("解析与格式化全部路由并往返一致", () => {
  const routes: Route[] = [
    { name: "chat", pid: "optics" },
    { name: "worker", pid: "optics", tid: "t5" },
    { name: "memory", pid: "optics" },
    { name: "usage", pid: "optics" },
    { name: "settings", section: "models" },
    { name: "settings", section: "roles" },
    { name: "settings", section: "mcp" },
    { name: "settings", section: "engine" },
    { name: "connect" },
  ];
  for (const route of routes) {
    const hash = formatRoute(route);
    assert.deepEqual(parseRoute(hash), route);
  }
});

test("支持编码过的项目编号与工单编号", () => {
  const route: Route = { name: "worker", pid: "proj a/b", tid: "t12" };
  const hash = formatRoute(route);
  assert.equal(hash, "#/p/proj%20a%2Fb/t/t12");
  assert.deepEqual(parseRoute(hash), route);
});

test("settings 缺失或未知子页时默认 models", () => {
  assert.deepEqual(parseRoute("#/settings"), { name: "settings", section: "models" });
  assert.deepEqual(parseRoute("#/settings/unknown"), { name: "settings", section: "models" });
});

test("空 hash、未知路径与 #code= 不被当成普通路由", () => {
  assert.equal(parseRoute(""), undefined);
  assert.equal(parseRoute("#"), undefined);
  assert.equal(parseRoute("#/"), undefined);
  assert.equal(parseRoute("#/unknown/path"), undefined);
  assert.equal(parseRoute("#/p/optics/extra"), undefined);
  assert.equal(parseRoute("#code=secret123"), undefined);
});

test("resolveRoute 在缺省时回退到默认项目或首页", () => {
  assert.deepEqual(resolveRoute("", "p1"), { name: "chat", pid: "p1" });
  assert.deepEqual(resolveRoute("#/unknown", "p1"), { name: "chat", pid: "p1" });
  assert.deepEqual(resolveRoute("", undefined), { name: "home" });
  assert.deepEqual(resolveRoute("#/settings/mcp", undefined), {
    name: "settings",
    section: "mcp",
  });
});

test("extractAuthCode 提取一次性授权码但不误伤普通路由", () => {
  assert.equal(extractAuthCode("#code=abc%2B123"), "abc+123");
  assert.equal(extractAuthCode("#?code=xyz"), "xyz");
  assert.equal(extractAuthCode("#code="), undefined);
  assert.equal(extractAuthCode("#/p/optics"), undefined);
  assert.equal(extractAuthCode(""), undefined);
});
