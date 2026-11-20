import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { findEngine } from "../cli/connection.ts";
import { SettingsStore } from "../config/settings.ts";
import { describeProblem } from "../domain/index.ts";
import { Engine } from "../engine/engine.ts";
import { createModelRuntime } from "../engine/models/index.ts";
import { createClient } from "../protocol/client.ts";
import { TOKEN_HEADER } from "../protocol/contract.ts";
import { STREAM_PROTOCOL, type StreamEvent } from "../protocol/stream.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { attachStream } from "../server/stream.ts";
import { eeveePaths } from "../shared/paths.ts";
import { writeRuntimeRecord } from "./instance.ts";

test("v2 parses resource params, emits problems and empty commands, and pushes engine changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-v2-"));
  const paths = eeveePaths(home);
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
  const engine = await Engine.open({
    paths,
    settings: await SettingsStore.open(paths.settings),
    models: await createModelRuntime(paths),
    context: BACKGROUND_CONTEXT,
  });
  const auth = new Auth();
  const token = auth.token;
  let port = 0;
  const server = createHttpServer({
    auth,
    uiDir: undefined,
    routes: createRoutes({
      engine,
      auth,
      port: () => port,
      version: "test-v2",
      shutdown: () => {},
    }),
  });
  const stream = attachStream(server, { source: engine, auth, version: "test-v2" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createClient({ baseUrl, token });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(baseUrl + path, {
      ...init,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    });
  const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/stream`, [
    STREAM_PROTOCOL,
    `token.${token}`,
  ]);
  const events: StreamEvent[] = [];
  const waiting: ((event: StreamEvent) => void)[] = [];
  ws.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as StreamEvent;
    const listener = waiting.shift();
    if (listener) listener(event);
    else events.push(event);
  });
  const next = () =>
    new Promise<StreamEvent>((resolve, reject) => {
      const event = events.shift();
      if (event) return resolve(event);
      const timer = setTimeout(() => reject(new Error("Timed out waiting for engine event")), 3000);
      waiting.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    assert.equal(ws.protocol, "eevee.v2");
    assert.equal((await next()).type, "hello");
    ws.send(JSON.stringify({ type: "watch", id: "engine", topic: { kind: "engine" } }));
    assert.deepEqual(await next(), {
      type: "engine",
      id: "engine",
      engine: { bootId: engine.bootId, version: "test-v2", projects: [] },
    });
    assert.deepEqual(await createClient({ baseUrl }).call("GET /api/health"), {
      bootId: engine.bootId,
      version: "test-v2",
    });
    assert.equal((await client.call("GET /api/engine")).pid, process.pid);
    await writeRuntimeRecord(paths.runtime.record, {
      pid: process.pid,
      port,
      bootId: "stale",
      version: "test-v2",
      token,
      startedAt: Date.now(),
    });
    assert.equal(await findEngine(paths), undefined);
    await writeRuntimeRecord(paths.runtime.record, {
      pid: process.pid,
      port,
      bootId: engine.bootId,
      version: "test-v2",
      token,
      startedAt: Date.now(),
    });
    assert.equal((await findEngine(paths))?.record.bootId, engine.bootId);

    assert.deepEqual(
      (await client.call("GET /api/memory/files")).files.map((file) => file.path),
      ["MEMORY.md"],
    );
    assert.match(
      (await client.call("GET /api/memory/files/:file", { file: "MEMORY.md" })).content,
      /Global memory/,
    );
    assert.ok((await client.call("GET /api/memory/changes")).changes.length > 0);
    await assert.rejects(client.call("GET /api/memory/files/:file", { file: ".git/HEAD" }), {
      status: 404,
    });

    const workspace = join(home, "workspace");
    await mkdir(workspace);
    const created = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "V2", workspace }),
    });
    assert.equal(created.status, 201);
    const summary = (await created.json()) as { id: string };
    const pushed = await next();
    assert.equal(pushed.type, "engine");
    assert.equal(pushed.type === "engine" && pushed.engine.projects[0]?.id, summary.id);
    assert.equal((await client.call("GET /api/projects")).projects.length, 1);
    assert.equal(
      (await client.call("GET /api/projects/:project", { project: summary.id })).title,
      "V2",
    );
    assert.deepEqual(
      (await client.call("GET /api/projects/:project/board", { project: summary.id })).tickets,
      [],
    );
    const conversation = await client.call(
      "GET /api/projects/:project/conversations/:conversation",
      {
        project: summary.id,
        conversation: "router",
      },
    );
    assert.equal(conversation.running, false);
    assert.equal(conversation.lines[0]?.role, "reset");
    assert.match(conversation.lines[0]?.text ?? "", /V2/);

    for (const conversation of ["t0", "t01", "worker", "t-1"]) {
      const reply = await request(`/api/projects/${summary.id}/conversations/${conversation}`);
      assert.equal(reply.status, 400);
      assert.match(reply.headers.get("content-type") ?? "", /application\/problem\+json/);
      const problem = await reply.json();
      assert.deepEqual(problem, {
        code: "invalid",
        field: "conversation",
        status: 400,
        title: describeProblem({ code: "invalid", field: "conversation" }),
      });
    }
    for (const [suffix, field] of [
      ["jobs/j0/log", "job"],
      ["questions/q0", "question"],
      ["memory/changes/0", "change"],
    ]) {
      const reply = await request(`/api/projects/${summary.id}/${suffix}`);
      assert.equal(reply.status, 400);
      assert.equal(((await reply.json()) as { field: string }).field, field);
    }
    for (const mode of ["steer", "followUp"]) {
      await assert.rejects(
        client.call(
          "POST /api/projects/:project/conversations/:conversation/messages",
          { project: summary.id, conversation: "router" },
          { text: "go", mode: mode as "steer" | "followUp" },
        ),
        { status: 400, problem: { code: "invalid", field: "mode" } },
      );
      await assert.rejects(
        client.call(
          "POST /api/projects/:project/conversations/:conversation/messages",
          { project: summary.id, conversation: "t1" },
          { text: "go", mode: mode as "steer" | "followUp" },
        ),
        { status: 404, problem: { code: "no_ticket", ticketId: "t1" } },
      );
    }
    await assert.rejects(
      client.call(
        "POST /api/projects/:project/conversations/:conversation/queue/:submission/steer",
        { project: summary.id, conversation: "router", submission: "1" },
      ),
      { status: 400, problem: { code: "invalid", field: "conversation" } },
    );
    const interrupted = await request(
      `/api/projects/${summary.id}/conversations/router/interrupt`,
      { method: "POST" },
    );
    assert.equal(interrupted.status, 204);
    assert.equal(await interrupted.text(), "");
    assert.equal(
      await client.call("POST /api/projects/:project/conversations/:conversation/interrupt", {
        project: summary.id,
        conversation: "router",
      }),
      undefined,
    );
    await client.call(
      "PUT /api/projects/:project/models/:role",
      { project: summary.id, role: "router" },
      { provider: "local", modelId: "demo" },
    );
    let updated = await next();
    while (updated.type === "engine" && updated.engine.projects[0]?.models === undefined)
      updated = await next();
    assert.equal(updated.type, "engine");
    assert.deepEqual(updated.type === "engine" && updated.engine.projects[0]?.models, {
      router: { provider: "local", modelId: "demo" },
    });
  } finally {
    ws.close();
    await stream.close();
    await new Promise((resolve) => server.close(resolve));
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
