import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, nextTick, shallowRef } from "vue";
import type { Client } from "../../../src/protocol/client.ts";
import type { EngineInfo, ProjectSummary } from "../../../src/protocol/views.ts";
import type { SessionInfo } from "../lib/session.ts";
import type { StreamClient } from "../lib/stream.ts";
import { useEngineData } from "./engine-data.ts";

test("engine pushes own the project list, including while an engine-info refresh is in flight", async () => {
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost" },
  });
  const scope = effectScope();
  const watches = new Map<string, Parameters<StreamClient["watch"]>[1]>();
  const requested: string[] = [];
  let finish: (info: EngineInfo) => void = () => {};
  let closed = false;
  const info: EngineInfo = { bootId: "boot", version: "test", port: 19190, pid: 1, startedAt: 1 };
  const stream = {
    state: "connected",
    watch: (id: string, registration: Parameters<StreamClient["watch"]>[1]) => {
      watches.set(id, registration);
      return () => {
        watches.delete(id);
      };
    },
    onState: () => () => {},
    onHello: () => () => {},
    close: () => {
      closed = true;
    },
  } as unknown as StreamClient;
  const client = {
    call: (route: string) => {
      requested.push(route);
      return new Promise<EngineInfo>((resolve) => {
        finish = resolve;
      });
    },
  } as Client;
  const session = shallowRef<SessionInfo>({
    client,
    token: "test",
    status: { ...info, projects: [] },
  });
  try {
    const data = scope.run(() => useEngineData(session, () => stream));
    assert.ok(data);
    const watch = watches.get("engine");
    assert.ok(watch);
    assert.deepEqual(watch.topic, { kind: "engine" });
    assert.equal(data.projects.value.length, 0);
    const push = (projects: ProjectSummary[]) =>
      watch.onEvent({
        type: "engine",
        id: "engine",
        engine: { bootId: "boot", version: "test", projects },
      });
    push([{ id: "p1", title: "One", workspace: "/one", createdAt: 1 }]);
    await nextTick();
    assert.equal(data.projects.value[0]?.title, "One");
    assert.ok([...watches.values()].some((watch) => watch.topic.kind === "board"));
    const refresh = data.refreshStatus();
    push([{ id: "p2", title: "Two", workspace: "/two", createdAt: 2 }]);
    finish(info);
    await refresh;
    await nextTick();
    assert.equal(data.projects.value[0]?.title, "Two");
    assert.deepEqual(requested, ["GET /api/engine"]);
    watch.onEvent({
      type: "error",
      id: "engine",
      error: { code: "invalid", field: "topic", title: "invalid topic", status: 400 },
    });
    assert.equal(data.statusError.value, "topic is not valid");
    push([]);
    assert.equal(data.projects.value.length, 0);
    assert.equal(data.statusError.value, undefined);
  } finally {
    scope.stop();
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
  assert.equal(closed, true);
  assert.equal(watches.size, 0);
});
