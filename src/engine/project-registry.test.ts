import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ProjectSummary } from "../protocol/views.ts";
import { eeveePaths } from "../shared/paths.ts";
import type { Project } from "./project/project.ts";
import { ProjectRegistry } from "./project-registry.ts";

test("project watches seed an empty list, coalesce summary changes and detach", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-registry-"));
  let current: ProjectSummary;
  let changed: () => void = () => {};
  const registry = new ProjectRegistry({
    paths: eeveePaths(home),
    open: async (meta, notify) => {
      current = meta;
      changed = notify;
      return { summary: () => current, close: async () => {} } as Project;
    },
  });
  try {
    await registry.initialize();
    const snapshots: ProjectSummary[][] = [];
    const stop = registry.watch((projects) => snapshots.push(projects));
    assert.deepEqual(snapshots, [[]]);
    assert.equal(registry.get("missing"), undefined);
    assert.throws(() => registry.require("missing"), {
      problem: { code: "no_project", projectId: "missing" },
    });
    const project = await registry.create({ title: "One", workspace: home });
    await nextTurn();
    assert.deepEqual(snapshots, [[], [project]]);
    current = { ...project, title: "Two" };
    changed();
    current = { ...current, activeAt: project.createdAt + 1 };
    changed();
    current = { ...current, models: { router: { provider: "test", modelId: "model" } } };
    changed();
    assert.equal(snapshots.length, 2);
    await nextTurn();
    assert.equal(snapshots.length, 3);
    assert.deepEqual(snapshots[2], [current]);
    changed();
    await nextTurn();
    assert.equal(snapshots.length, 3);
    stop();
    current = { ...current, title: "Three" };
    changed();
    await nextTurn();
    assert.equal(snapshots.length, 3);
  } finally {
    await registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
