import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fakeMcpServer, weatherTool } from "../extensions/mcp/testing.ts";
import { createModelRuntime } from "../models/index.ts";
import { eeveePaths } from "../shared/paths.ts";
import { SettingsStore } from "../shared/settings.ts";
import { Engine, UnknownExtension } from "./engine.ts";

test("Engine 汇总可启用的扩展；按角色启用要求已安装，写进 settings.json 并应用到各项目", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-engine-"));
  const paths = eeveePaths(home);
  await mkdir(paths.extensions, { recursive: true });
  await writeFile(join(paths.extensions, "notes.mjs"), `export default { name: "notes" };`);
  await writeFile(paths.mcp, JSON.stringify({ mcpServers: { weather: { command: "unused" } } }));
  const server = fakeMcpServer([weatherTool]);

  const engine = await Engine.open({
    paths,
    settings: await SettingsStore.open(paths.settings),
    models: await createModelRuntime(paths),
    context: BACKGROUND_CONTEXT,
    openMcp: () => server.client,
  });
  try {
    const workspace = join(home, "workspace");
    await mkdir(workspace);
    await engine.createProject({ title: "测试", workspace });

    for (let i = 0; i < 100 && engine.capabilities().mcp[0]?.state !== "connected"; i++) {
      await sleep(10);
    }
    const view = engine.capabilities();
    assert.deepEqual(
      view.available.map((e) => e.name),
      ["tool-search", "codemode", "mcp.weather", "notes"],
    );
    assert.equal(view.mcp[0]?.tools, 1);
    assert.deepEqual(view.roles.find((r) => r.role === "worker")?.builtIn, [
      "eevee.resources",
      "eevee.workspace",
      "eevee.report",
    ]);

    await assert.rejects(
      engine.setRoleCapability("worker", { extensions: ["mcp.nope"] }),
      UnknownExtension,
    );
    const updated = await engine.setRoleCapability("worker", {
      extensions: ["mcp.weather", "notes", "notes"],
      maxTurns: 30,
    });
    const worker = updated.roles.find((r) => r.role === "worker");
    assert.deepEqual(worker?.enabled, ["mcp.weather", "notes"]);
    assert.equal(worker?.maxTurns, 30);
    const stored = JSON.parse(await readFile(paths.settings, "utf8"));
    assert.deepEqual(stored.roles.worker, { extensions: ["mcp.weather", "notes"], maxTurns: 30 });

    await engine.setRoleCapability("worker", { maxTurns: null });
    assert.equal(engine.capabilities().roles.find((r) => r.role === "worker")?.maxTurns, undefined);
  } finally {
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
