import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ApiRequestError, createClient } from "../api/client.ts";
import { fakeMcpServer, weatherTool } from "../extensions/mcp/testing.ts";
import { createModelRuntime } from "../models/index.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { readText } from "../shared/fs.ts";
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

test("HTTP 接口暴露结构化模型、项目 activeAt、Board.router 与嵌套记忆文件", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-http-"));
  const paths = eeveePaths(home);
  const settings = await SettingsStore.open(paths.settings);
  await writeFile(
    paths.models,
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          models: [{ id: "demo", name: "Demo", contextWindow: 16384 }],
        },
      },
    }),
  );
  await settings.update((s) => ({
    ...s,
    models: { default: { provider: "local", modelId: "demo" } },
  }));
  const engine = await Engine.open({
    paths,
    settings,
    models: await createModelRuntime(paths),
    context: BACKGROUND_CONTEXT,
  });
  const auth = await Auth.open({
    cliTokenPath: paths.runtime.cliToken,
    sessionsPath: paths.runtime.sessions,
  });
  const token = (await readText(paths.runtime.cliToken))?.trim();
  let listenPort = 0;
  const server = createHttpServer({
    routes: createRoutes({
      engine,
      auth,
      port: () => listenPort,
      version: "0.0.0-test",
      shutdown: () => {},
    }),
    auth,
    uiDir: undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  listenPort = (server.address() as AddressInfo).port;
  const client = createClient({ baseUrl: `http://127.0.0.1:${listenPort}`, token });

  try {
    const models = await client.call("GET /api/models");
    assert.deepEqual(models.routerModel, { provider: "local", modelId: "demo" });
    assert.match(models.catalog, /local\/demo/);
    assert.equal(
      models.providers.some((p) => p.id === "local" && p.custom),
      true,
    );

    const workspace = join(home, "ws");
    await mkdir(workspace);
    const created = await client.call("POST /api/projects", { title: "HTTP", workspace });
    assert.equal(created.activeAt, created.createdAt);

    const status = await client.call("GET /api/status");
    assert.equal(status.projects[0]?.activeAt, created.createdAt);

    const board = await client.call("GET /api/projects/:project/board", { project: created.id });
    assert.deepEqual(board.router, { running: false });

    await mkdir(join(paths.project(created.id).memory, "topics"), { recursive: true });
    await writeFile(join(paths.project(created.id).memory, "topics", "a.md"), "# Note A\n");
    const listed = await client.call("GET /api/projects/:project/memory/:scope/files", {
      project: created.id,
      scope: "project",
    });
    assert.deepEqual(
      listed.files.map((f) => f.path),
      ["MEMORY.md", "topics/a.md"],
    );

    const file = await client.call("GET /api/projects/:project/memory/:scope/files/:file", {
      project: created.id,
      scope: "project",
      file: "topics/a.md",
    });
    assert.equal(file.content, "# Note A\n");

    await assert.rejects(
      client.call("GET /api/projects/:project/memory/:scope/files/:file", {
        project: created.id,
        scope: "project",
        file: ".git/HEAD",
      }),
      (err: unknown) => err instanceof ApiRequestError && err.status === 404,
    );
    await assert.rejects(
      client.call("GET /api/projects/:project/jobs/:job/log", {
        project: created.id,
        job: "j1",
      }),
      (err: unknown) => err instanceof ApiRequestError && err.status === 404,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
