import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsStore } from "../config/settings.ts";
import { Engine } from "../engine/engine.ts";
import { fakeMcpServer, weatherTool } from "../engine/extensions/mcp/testing.ts";
import { createModelRuntime } from "../engine/models/index.ts";
import { createClient } from "../protocol/client.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { readText } from "../shared/fs.ts";
import { eeveePaths } from "../shared/paths.ts";

test("the Engine collects the extensions that can be enabled; a role only gets what is installed, written to settings.json and applied to every project", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-engine-"));
  const paths = eeveePaths(home);
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
    await engine.createProject({ title: "Test", workspace });

    for (let i = 0; i < 100 && engine.capabilities().mcp[0]?.state !== "connected"; i++) {
      await sleep(10);
    }
    const view = engine.capabilities();
    assert.deepEqual(
      view.available.map((e) => e.name),
      ["tool-search", "codemode", "mcp.weather"],
    );
    assert.equal(view.mcp[0]?.tools, 1);
    assert.deepEqual(view.roles.find((r) => r.role === "worker")?.builtIn, [
      "eevee.resources",
      "eevee.workspace",
      "eevee.report",
    ]);

    await assert.rejects(engine.setRoleCapability("worker", { extensions: ["mcp.nope"] }), {
      problem: { code: "no_extension", names: ["mcp.nope"] },
    });
    const updated = await engine.setRoleCapability("worker", {
      extensions: ["mcp.weather", "tool-search", "tool-search"],
      maxTurns: 30,
    });
    const worker = updated.roles.find((r) => r.role === "worker");
    assert.deepEqual(worker?.enabled, ["mcp.weather", "tool-search"]);
    assert.equal(worker?.maxTurns, 30);
    const stored = JSON.parse(await readFile(paths.settings, "utf8"));
    assert.deepEqual(stored.roles.worker, {
      extensions: ["mcp.weather", "tool-search"],
      maxTurns: 30,
    });

    await engine.setRoleCapability("worker", { maxTurns: null });
    assert.equal(engine.capabilities().roles.find((r) => r.role === "worker")?.maxTurns, undefined);
  } finally {
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("an extension a role enabled and that was later uninstalled does not block edits and can be removed one by one; a newly enabled one still has to be installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-engine-"));
  const paths = eeveePaths(home);
  const settings = await SettingsStore.open(paths.settings);
  await settings.update((s) => ({
    ...s,
    roles: { worker: { extensions: ["mcp.gone", "mcp.left"] } },
  }));
  const engine = await Engine.open({
    paths,
    settings,
    models: await createModelRuntime(paths),
    context: BACKGROUND_CONTEXT,
  });
  const enabled = () => engine.capabilities().roles.find((r) => r.role === "worker")?.enabled;
  try {
    await engine.setRoleCapability("worker", {
      extensions: ["mcp.gone", "mcp.left", "tool-search"],
    });
    assert.deepEqual(enabled(), ["mcp.gone", "mcp.left", "tool-search"]);

    await engine.setRoleCapability("worker", { extensions: ["mcp.left", "tool-search"] });
    assert.deepEqual(enabled(), ["mcp.left", "tool-search"]);

    await assert.rejects(
      engine.setRoleCapability("worker", { extensions: ["mcp.left", "mcp.gone"] }),
      { problem: { code: "no_extension", names: ["mcp.gone"] } },
    );
    assert.deepEqual(enabled(), ["mcp.left", "tool-search"]);
  } finally {
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the HTTP API exposes structured models, project activeAt, Board.router and nested memory files", async () => {
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
  const auth = await Auth.open({ tokenPath: paths.runtime.token });
  const token = (await readText(paths.runtime.token))?.trim();
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

    const board = await engine.project(created.id)?.board();
    assert.deepEqual(board?.router, { running: false });

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
      // A refusal is data the panel can word; the status follows from its code.
      {
        name: "ApiRequestError",
        status: 404,
        problem: { code: "no_memory_file", file: ".git/HEAD" },
        message: "No memory file .git/HEAD",
      },
    );
    await assert.rejects(
      client.call("GET /api/projects/:project/jobs/:job/log", {
        project: created.id,
        job: "j1",
      }),
      { status: 404, problem: { code: "no_job", jobId: "j1" } },
    );
    await assert.rejects(
      client.call("GET /api/projects/:project/memory/:scope/files", {
        project: created.id,
        scope: "team",
      }),
      { status: 400, problem: { code: "invalid", field: "scope", allowed: ["project", "global"] } },
    );
    await assert.rejects(
      client.call("GET /api/projects/:project/memory/:scope/files", {
        project: "p0",
        scope: "project",
      }),
      { status: 404, problem: { code: "no_project", projectId: "p0" } },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the HTTP boundary refuses a body that is missing a field, of the wrong type, blank, or off an enum", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-http-body-"));
  const paths = eeveePaths(home);
  const settings = await SettingsStore.open(paths.settings);
  await writeFile(
    paths.models,
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          models: [{ id: "demo" }],
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
  const { client, close } = await serve(engine, paths);
  const workspace = join(home, "ws");
  await mkdir(workspace);
  try {
    // A field the route needs is missing: `required` names it, an absent body included.
    await assert.rejects(client.call("POST /api/session", refused({})), {
      status: 400,
      problem: { code: "required", field: "code" },
    });
    await assert.rejects(client.call("POST /api/projects", refused({ title: "HTTP" })), {
      status: 400,
      problem: { code: "required", field: "workspace" },
    });

    // A field of the wrong type is `invalid`, not a missing one.
    await assert.rejects(client.call("POST /api/session", refused({ code: 1 })), {
      status: 400,
      problem: { code: "invalid", field: "code" },
    });
    await assert.rejects(
      client.call("POST /api/projects/:project/messages", { project: "p0" }, refused({ text: 7 })),
      { status: 400, problem: { code: "invalid", field: "text" } },
    );

    // Blank counts as missing for a field that has to carry something.
    await assert.rejects(client.call("POST /api/projects", refused({ title: " ", workspace })), {
      status: 400,
      problem: { code: "required", field: "title" },
    });

    // An enum names the values it takes.
    await assert.rejects(
      client.call(
        "POST /api/settings/models",
        refused({
          role: "x",
          provider: "local",
          modelId: "demo",
        }),
      ),
      {
        status: 400,
        problem: {
          code: "invalid",
          field: "role",
          allowed: ["router", "worker", "dreamer", "default"],
        },
      },
    );
    await assert.rejects(
      client.call(
        "POST /api/projects/:project/tickets/:ticket/messages",
        { project: "p0", ticket: "t1" },
        refused({ text: "go on", mode: "now" }),
      ),
      {
        status: 400,
        problem: { code: "invalid", field: "mode", allowed: ["steer", "followUp"] },
      },
    );
    await assert.rejects(
      client.call(
        "POST /api/settings/models",
        refused({
          provider: "local",
          modelId: "demo",
          thinkingLevel: "loud",
        }),
      ),
      {
        status: 400,
        problem: {
          code: "invalid",
          field: "thinkingLevel",
          allowed: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        },
      },
    );
  } finally {
    await close();
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

/** A body the route's type would refuse, sent on purpose to see the boundary refuse it too. */
const refused = (body: unknown) => body as never;

/** Serves the Engine's routes on a free port, with a client holding the token. */
async function serve(engine: Engine, paths: ReturnType<typeof eeveePaths>) {
  const auth = await Auth.open({ tokenPath: paths.runtime.token });
  const token = (await readText(paths.runtime.token))?.trim();
  let port = 0;
  const server = createHttpServer({
    routes: createRoutes({ engine, auth, port: () => port, version: "0", shutdown: () => {} }),
    auth,
    uiDir: undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, token });
  return { client, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the panel edits providers over the local API: a write applies at once, the default model's provider cannot be deleted, and deleting a custom one takes its key", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-providers-"));
  const paths = eeveePaths(home);
  const settings = await SettingsStore.open(paths.settings);
  const local = {
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    models: [{ id: "demo" }],
  };
  await writeFile(paths.models, JSON.stringify({ providers: { local } }));
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
  const { client, close } = await serve(engine, paths);
  try {
    assert.deepEqual((await client.call("GET /api/models/config")).providers, { local });

    const gw = {
      baseUrl: "https://gw.example/v1",
      api: "openai-responses",
      models: [{ id: "m1" }],
    };
    const view = await client.call(
      "PUT /api/models/providers/:provider",
      { provider: "gw" },
      { config: gw },
    );
    const added = view.providers.find((p) => p.id === "gw");
    assert.deepEqual(
      [added?.custom, added?.builtIn, added?.configured, added?.modelCount],
      [true, false, false, 1],
    );
    const anthropic = view.providers.find((p) => p.id === "anthropic");
    assert.equal(anthropic?.builtIn, true);
    assert.equal(anthropic?.defaultBaseUrl, "https://api.anthropic.com");

    // References come from pi-ai's own catalog, the caller's API first, never from models.json.
    const refs = await client.call("POST /api/models/builtin", {
      query: "claude-sonnet-4-5",
      api: "anthropic-messages",
    });
    assert.equal(
      `${refs.models[0]?.provider}/${refs.models[0]?.id}`,
      "anthropic/claude-sonnet-4-5",
    );
    assert.ok(refs.models.length <= 8);
    const demo = await client.call("POST /api/models/builtin", { query: "m1" });
    assert.equal(
      demo.models.some((m) => m.provider === "local" || m.provider === "gw"),
      false,
    );
    await assert.rejects(client.call("POST /api/models/builtin", { query: " " }), {
      status: 400,
      problem: { code: "required", field: "query" },
    });

    await client.call("POST /api/auth/:provider", { provider: "gw" }, { key: "sk-gw" });
    let gwView = (await client.call("GET /api/models")).providers.find((p) => p.id === "gw");
    assert.deepEqual([gwView?.configured, gwView?.source], [true, "auth.json"]);
    await client.call("DELETE /api/auth/:provider", { provider: "gw" });
    gwView = (await client.call("GET /api/models")).providers.find((p) => p.id === "gw");
    assert.equal(gwView?.configured, false);

    await assert.rejects(
      client.call(
        "PUT /api/models/providers/:provider",
        { provider: "local" },
        {
          config: { ...local, models: [{ id: "other" }] },
        },
      ),
      { status: 409, problem: { code: "model_in_use", provider: "local", modelId: "demo" } },
    );
    await assert.rejects(
      client.call("PUT /api/models/providers/:provider", { provider: "a b" }, { config: gw }),
      { status: 400, problem: { code: "invalid", field: "provider" } },
    );
    await assert.rejects(
      client.call(
        "PUT /api/models/providers/:provider",
        { provider: "gw" },
        {
          config: { ...gw, models: [] },
        },
      ),
      (error: { status: number; problem: { code: string } }) =>
        error.status === 422 && error.problem.code === "bad_config",
    );

    await client.call("POST /api/auth/:provider", { provider: "gw" }, { key: "sk-gw" });
    await client.call("DELETE /api/models/providers/:provider", { provider: "gw" });
    assert.equal(
      (await client.call("GET /api/models")).providers.some((p) => p.id === "gw"),
      false,
    );
    assert.equal(JSON.parse((await readText(paths.auth)) ?? "{}").gw, undefined);
  } finally {
    await close();
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the panel edits MCP servers over the local API: only the changed one reconnects, deleting removes it from every role, and the rest of the file is kept", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-mcp-edit-"));
  const paths = eeveePaths(home);
  await writeFile(paths.mcp, JSON.stringify({ $comment: "my servers", mcpServers: {} }));
  const engine = await Engine.open({
    paths,
    settings: await SettingsStore.open(paths.settings),
    models: await createModelRuntime(paths),
    context: BACKGROUND_CONTEXT,
    openMcp: () => fakeMcpServer([weatherTool]).client,
  });
  const { client, close } = await serve(engine, paths);
  try {
    const entry = { command: "weather-mcp", args: ["--stdio"], exposure: "direct" };
    await client.call("PUT /api/mcp/servers/:server", { server: "weather" }, { config: entry });
    for (let i = 0; i < 100 && engine.capabilities().mcp[0]?.state !== "connected"; i++) {
      await sleep(10);
    }
    assert.deepEqual(
      engine.capabilities().mcp.map((m) => [m.name, m.state, m.exposure, m.tools]),
      [["weather", "connected", "direct", 1]],
    );
    assert.deepEqual((await client.call("GET /api/mcp/config")).servers, { weather: entry });
    await client.call(
      "POST /api/capabilities/roles/:role",
      { role: "worker" },
      {
        extensions: ["mcp.weather"],
      },
    );

    await assert.rejects(
      client.call(
        "PUT /api/mcp/servers/:server",
        { server: "weather" },
        {
          config: { command: "weather-mcp", exposure: "loud" },
        },
      ),
      (error: { status: number; problem: { code: string } }) =>
        error.status === 422 && error.problem.code === "bad_config",
    );

    const view = await client.call("DELETE /api/mcp/servers/:server", { server: "weather" });
    assert.deepEqual(view.mcp, []);
    assert.deepEqual(view.roles.find((r) => r.role === "worker")?.enabled, []);
    assert.deepEqual(JSON.parse((await readText(paths.mcp)) ?? "{}"), {
      $comment: "my servers",
      mcpServers: {},
    });
  } finally {
    await close();
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
