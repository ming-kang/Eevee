import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsStore } from "../config/settings.ts";
import { eeveePaths } from "../shared/paths.ts";
import { Engine } from "./engine.ts";
import { createModelRuntime } from "./models/index.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { SharedExtensions, type SharedExtensionsOptions } from "./shared-extensions.ts";

for (const stage of ["shared", "project", "cleanup failure"]) {
  test(`failed Engine startup closes acquired resources: ${stage}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "eevee-engine-failure-"));
    const paths = eeveePaths(home);
    const failure = new Error("project initialization failed");
    const cleanup: Array<() => Promise<void>> = [];
    const closed: string[] = [];
    const openShared = SharedExtensions.open;
    t.mock.method(SharedExtensions, "open", async (options: SharedExtensionsOptions) => {
      const shared = await openShared.call(SharedExtensions, options);
      const close = () => SharedExtensions.prototype.close.call(shared);
      cleanup.push(close);
      t.mock.method(shared, "close", async () => {
        closed.push("shared");
        await close();
        if (stage === "cleanup failure") throw new Error("transport close failed");
      });
      return shared;
    });
    t.mock.method(ProjectRegistry.prototype, "initialize", async function (this: ProjectRegistry) {
      if (stage !== "shared") {
        const meta = await this.create({ title: "Opened project", workspaces: [home] });
        const project = this.require(meta.id);
        const close = project.close.bind(project);
        cleanup.push(close);
        t.mock.method(project, "close", async () => {
          closed.push("project");
          await close();
        });
      }
      throw failure;
    });
    try {
      await assert.rejects(
        Engine.open({
          paths,
          settings: await SettingsStore.open(paths.settings),
          models: await createModelRuntime(paths),
          context: BACKGROUND_CONTEXT,
        }),
        (error) => error === failure,
      );
      assert.deepEqual(closed.sort(), stage === "shared" ? ["shared"] : ["project", "shared"]);
    } finally {
      await Promise.allSettled(cleanup.map((close) => close()));
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}
