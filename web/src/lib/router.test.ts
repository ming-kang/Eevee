import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, nextTick, shallowRef, watch } from "vue";
import {
  controlProjectId,
  extractAuthCode,
  formatRoute,
  parseRoute,
  type Route,
  resolveRoute,
  retainBackgroundRoute,
  routerProjectId,
} from "./router.ts";

test("Worker routes retain the Router subscription across opening, switching and closing tickets", async () => {
  const route = shallowRef(resolveRoute("#/p/p1"));
  const project = computed(() =>
    route.value.name === "control" ? undefined : routerProjectId(route.value),
  );
  const subscriptions: (string | undefined)[] = [];
  const stop = watch(project, (pid) => subscriptions.push(pid), { immediate: true });
  for (const hash of ["#/p/p1/t/t4", "#/p/p1/t/t5", "#/p/p1"]) {
    route.value = resolveRoute(hash);
    await nextTick();
  }
  assert.deepEqual(subscriptions, ["p1"]);
  route.value = resolveRoute("#/p/p2/t/t1");
  await nextTick();
  route.value = resolveRoute("#/");
  await nextTick();
  stop();
  assert.deepEqual(subscriptions, ["p1", "p2", undefined]);
});

test("every route parses and formats and round-trips", () => {
  const routes: Route[] = [
    { name: "chat", pid: "optics" },
    { name: "chat", pid: "optics", qid: "q4" },
    { name: "worker", pid: "optics", tid: "t5" },
    { name: "worker", pid: "optics", tid: "t5", qid: "q2" },
    { name: "control", section: "memory" },
    { name: "control", section: "usage", pid: "optics a/b" },
    { name: "control", section: "general" },
    { name: "control", section: "models" },
    { name: "control", section: "roles" },
    { name: "control", section: "mcp" },
    { name: "control", section: "engine" },
    { name: "control", section: "models", item: "my gw" },
    { name: "control", section: "mcp", item: "+" },
    { name: "connect" },
    { name: "overview" },
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

test("Worker question deep links preserve the selected question and reject malformed targets", () => {
  const route: Route = { name: "worker", pid: "proj a/b", tid: "t4", qid: "q2" };
  assert.equal(formatRoute(route), "#/p/proj%20a%2Fb/t/t4/q/q2");
  assert.deepEqual(parseRoute("#/p/proj%20a%2Fb/t/t4/q/%712"), route);
  assert.deepEqual(resolveRoute(formatRoute(route), "other"), route);
  for (const hash of [
    "#/p/p1/t/t4/q",
    "#/p/p1/t/t4/q/nope",
    "#/p/p1/t/t4/q/%E0%A4",
    "#/p/p1/t/t4/q/q2/extra",
    "#/p/p1/t/t4/nope/q2",
  ]) {
    assert.equal(parseRoute(hash), undefined);
  }
});

test("an Overview question link preserves its target when opening or reloading a project", () => {
  const route: Route = { name: "chat", pid: "proj a/b", qid: "q2" };
  const hash = "#/p/proj%20a%2Fb/q/q2";
  assert.equal(formatRoute(route), hash);
  assert.deepEqual(parseRoute(hash), route);
  assert.deepEqual(resolveRoute(hash, "another-project"), route);
  for (const invalid of ["#/p/optics/q/nope", "#/p/optics/q/%E0%A4", "#/p/optics/q/q2/extra"]) {
    assert.equal(parseRoute(invalid), undefined);
  }
});

test("legacy settings resolve to Control and default to general", () => {
  assert.deepEqual(parseRoute("#/settings"), { name: "control", section: "general" });
  assert.deepEqual(parseRoute("#/settings/unknown"), { name: "control", section: "general" });
  assert.deepEqual(parseRoute("#/settings/general/x"), { name: "control", section: "general" });
  assert.deepEqual(parseRoute("#/settings/models/openai"), {
    name: "control",
    section: "models",
    item: "openai",
  });
});

test("legacy project utilities select that project and format as Control links", () => {
  for (const section of ["memory", "usage"] as const) {
    const route = parseRoute(`#/p/proj%20a%2Fb/${section}`);
    assert.deepEqual(route, { name: "control", section, pid: "proj a/b" });
    assert.equal(formatRoute(route as Route), `#/control/${section}?project=proj%20a%2Fb`);
  }
});

test("Control handles empty, unknown and malformed sections and item encoding", () => {
  for (const hash of ["#/control", "#/control/unknown", "#/control/%E0%A4"]) {
    assert.deepEqual(parseRoute(hash), { name: "control", section: "general" });
  }
  assert.deepEqual(parseRoute("#/control/models/%E0%A4"), { name: "control", section: "models" });
  assert.deepEqual(parseRoute("#/control/memory/ignored"), { name: "control", section: "memory" });
  assert.deepEqual(parseRoute("#/control/mcp/server%2Fone"), {
    name: "control",
    section: "mcp",
    item: "server/one",
  });
});

test("Control retains the last background, defaults to Overview and yields to ticket navigation", () => {
  const home = { name: "overview" } as const;
  const worker = { name: "worker", pid: "p1", tid: "t1" } as const;
  const control = { name: "control", section: "memory" } as const;
  assert.deepEqual(retainBackgroundRoute(control, home), home);
  assert.deepEqual(retainBackgroundRoute(control, worker), worker);
  assert.deepEqual(retainBackgroundRoute(worker, home), worker);
  assert.equal(controlProjectId(control, worker, "p2"), "p1");
  assert.equal(controlProjectId(control, home, "p2"), "p2");
  assert.equal(controlProjectId(control, home), undefined);
  assert.equal(controlProjectId({ ...control, pid: "p3" }, worker, "p2"), "p3");
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
  assert.deepEqual(resolveRoute("", "p1"), { name: "overview" });
  assert.deepEqual(resolveRoute("#", "p1"), { name: "overview" });
  assert.deepEqual(resolveRoute("#/", "p1"), { name: "overview" });
  assert.deepEqual(resolveRoute("#/unknown", "p1"), { name: "chat", pid: "p1" });
  assert.deepEqual(resolveRoute("", undefined), { name: "overview" });
  assert.deepEqual(resolveRoute("#/settings/mcp", undefined), {
    name: "control",
    section: "mcp",
  });
});

test("Overview is canonical while home and empty hashes remain aliases", () => {
  for (const hash of ["", "#", "#/", "#/home", "#/overview"]) {
    const route = resolveRoute(hash, "p1");
    assert.deepEqual(route, { name: "overview" });
    assert.equal(formatRoute(route), "#/overview");
  }
  assert.deepEqual(parseRoute("#/home"), { name: "overview" });
  assert.deepEqual(parseRoute("#/overview"), { name: "overview" });
  assert.equal(parseRoute("#/overview/extra"), undefined);
  assert.equal(parseRoute("#/home/extra"), undefined);
});

test("extractAuthCode reads the one-time code without disturbing normal routes", () => {
  assert.equal(extractAuthCode("#code=abc%2B123"), "abc+123");
  assert.equal(extractAuthCode("#?code=xyz"), "xyz");
  assert.equal(extractAuthCode("#code="), undefined);
  assert.equal(extractAuthCode("#/p/optics"), undefined);
  assert.equal(extractAuthCode(""), undefined);
});
