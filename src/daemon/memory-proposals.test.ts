import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SettingsStore } from "../config/settings.ts";
import { Engine } from "../engine/engine.ts";
import { createModelRuntime } from "../engine/models/index.ts";
import { textOf } from "../engine/testing.ts";
import { createClient } from "../protocol/client.ts";
import { TOKEN_HEADER } from "../protocol/contract.ts";
import { STREAM_PROTOCOL, type StreamEvent, TOKEN_PROTOCOL_PREFIX } from "../protocol/stream.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { attachStream } from "../server/stream.ts";
import { eeveePaths } from "../shared/paths.ts";

test("proposal routes and board stream require approval; rejected and stale decisions wake Router", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "eevee-proposals-"));
  const paths = eeveePaths(home);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const turns: string[] = [];
  faux.setResponses(
    Array.from({ length: 100 }, () => (transcript) => {
      const last = transcript.messages.at(-1);
      const text = textOf(last);
      if (last?.role === "user") turns.push(text);
      if (last?.role === "user" && text.startsWith("propose:")) {
        const scope = text.includes("global") ? "global" : "project";
        return fauxAssistantMessage(
          fauxToolCall("memory", { action: "write", scope, file: "MEMORY.md", content: text }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("Recorded.");
    }),
  );
  const settings = await SettingsStore.open(paths.settings);
  await settings.update((stored) => ({
    ...stored,
    models: { default: { provider: "faux", modelId: "m1" } },
  }));
  const engine = await Engine.open({
    paths,
    settings,
    context: BACKGROUND_CONTEXT,
    models: await createModelRuntime(paths, {
      base: () => {
        const models = createModels();
        models.setProvider(faux.provider);
        return models;
      },
    }),
  });
  const auth = new Auth();
  const server = createHttpServer({
    auth,
    uiDir: undefined,
    routes: createRoutes({ engine, auth, port: () => 0, version: "test", shutdown: () => {} }),
  });
  const stream = attachStream(server, { source: engine, auth, version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createClient({ baseUrl, token: auth.token });
  let socket: WebSocket | undefined;
  t.after(async () => {
    socket?.close();
    await stream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });
  async function until(probe: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!(await probe())) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for proposal");
      await sleep(10);
    }
  }
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const { id } = await client.call("POST /api/projects", { title: "Proposals", workspace });
  const project = engine.projects.require(id);
  const events: StreamEvent[] = [];
  socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/stream`, [
    STREAM_PROTOCOL,
    `${TOKEN_PROTOCOL_PREFIX}${auth.token}`,
  ]);
  socket.addEventListener("message", (event) =>
    events.push(JSON.parse(String(event.data)) as StreamEvent),
  );
  await new Promise<void>((resolve, reject) => {
    socket?.addEventListener("open", () => resolve(), { once: true });
    socket?.addEventListener("error", () => reject(new Error("Stream failed")), { once: true });
  });
  socket.send(
    JSON.stringify({ type: "watch", id: "board", topic: { kind: "board", project: id } }),
  );
  const initial = await project.memory.file("project", "MEMORY.md");
  assert.deepEqual(
    await client.call("GET /api/projects/:project/memory/proposals", { project: id }),
    { proposals: [] },
  );

  await project.conversations.send("router", "propose:project:first");
  await until(
    async () =>
      (await project.proposals.list()).length === 1 && !(await project.board()).router.running,
  );
  await until(() =>
    events.some(
      (event) => event.type === "board" && event.board.openProposals.some((p) => p.id === "m1"),
    ),
  );
  assert.equal((await project.memory.file("project", "MEMORY.md")).content, initial.content);
  const detail = await client.call("GET /api/projects/:project/memory/proposals/:proposal", {
    project: id,
    proposal: "m1",
  });
  assert.equal(detail.status, "pending");
  assert.ok(
    detail.files[0]?.hunks.some((h) =>
      h.lines.some((l) => l.kind === "add" && l.text === "propose:project:first"),
    ),
  );
  const change = await client.call(
    "POST /api/projects/:project/memory/proposals/:proposal/approve",
    { project: id, proposal: "m1" },
  );
  assert.deepEqual(change.source, { kind: "router" });
  assert.equal(
    (await project.memory.file("project", "MEMORY.md")).content,
    "propose:project:first",
  );
  assert.equal((await project.proposals.get("m1")).files.length, 1);
  assert.deepEqual((await project.board()).openProposals, []);
  assert.equal(
    turns.some((text) => /Memory proposal m1 .*approved/.test(text)),
    false,
  );
  await assert.rejects(
    client.call("POST /api/projects/:project/memory/proposals/:proposal/approve", {
      project: id,
      proposal: "m1",
    }),
    { status: 409, problem: { code: "proposal_decided", proposalId: "m1" } },
  );

  await project.conversations.send("router", "propose:global:second");
  await until(
    async () =>
      (await project.proposals.list()).length === 2 && !(await project.board()).router.running,
  );
  assert.equal((await project.proposals.get("m2")).scope, "global");
  const rejection = await fetch(`${baseUrl}/api/projects/${id}/memory/proposals/m2/reject`, {
    method: "POST",
    headers: { [TOKEN_HEADER]: auth.token, "content-type": "application/json" },
    body: JSON.stringify({ reason: "Keep the current wording" }),
  });
  assert.equal(rejection.status, 204);
  assert.equal(await rejection.text(), "");
  await until(() =>
    turns.some(
      (text) =>
        /Memory proposal m2 .*rejected/.test(text) && text.includes("Keep the current wording"),
    ),
  );
  assert.equal((await project.proposals.get("m2")).reason, "Keep the current wording");
  assert.notEqual((await engine.memory.file("MEMORY.md")).content, "propose:global:second");

  await project.conversations.send("router", "propose:project:stale");
  await until(
    async () =>
      (await project.proposals.list()).length === 3 && !(await project.board()).router.running,
  );
  await writeFile(join(paths.project(id).memory, "MEMORY.md"), "Hand edited");
  await assert.rejects(
    client.call("POST /api/projects/:project/memory/proposals/:proposal/approve", {
      project: id,
      proposal: "m3",
    }),
    { status: 409, problem: { code: "memory_changed", file: "MEMORY.md" } },
  );
  assert.equal((await project.memory.file("project", "MEMORY.md")).content, "Hand edited");
  await until(() =>
    turns.some((text) => /Memory proposal m3 .*stale/.test(text) && text.includes("MEMORY.md")),
  );
  assert.equal((await project.proposals.get("m3")).status, "stale");
  assert.deepEqual((await project.board()).openProposals, []);
  const rejected = await fetch(`${baseUrl}/api/projects/${id}/memory/proposals/m3/reject`, {
    method: "POST",
    headers: { [TOKEN_HEADER]: auth.token, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(rejected.status, 409);
  for (const [proposal, status, code] of [
    ["m0", 400, "invalid"],
    ["m999", 404, "no_proposal"],
  ] as const) {
    await assert.rejects(
      client.call("GET /api/projects/:project/memory/proposals/:proposal", {
        project: id,
        proposal,
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === status &&
        "problem" in error &&
        (error.problem as { code: string }).code === code,
    );
  }
});
