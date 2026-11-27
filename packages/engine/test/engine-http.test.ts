import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { bool, obj } from "@earendil-works/pi-schema";
import {
  type BoardStreamEvent,
  BoardViewSchema,
  type ConversationStreamEvent,
  ConversationViewPayloadSchema,
  CreateProjectResponseSchema,
  EeveeApiError,
  EeveeClient,
  GetProjectResponseSchema,
  HealthResponseSchema,
  ListProjectsResponseSchema,
  ListProjectTasksResponseSchema,
  ProblemSchema,
  parseWithSchema,
  SendMessageResponseSchema,
} from "@eevee/protocol";
import { decodeCursor, encodeCursor } from "../src/cursor.ts";
import { RouteTrie, route } from "../src/http-io.ts";
import {
  connectLocalEngine,
  Engine,
  EngineError,
  EngineStore,
  ensureAuthToken,
  readAuthToken,
  readEngineState,
  removeEngineState,
  startEngineHttpServer,
  startForegroundEngine,
  verifyBearerToken,
  writeEngineState,
} from "../src/index.ts";

const MODEL_ID = "faux-1";

function messageText(message: Message): string {
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
    return contentText(message.content);
  }
  return "";
}

function lastMessage(context: TranscriptContext): Message | undefined {
  return context.messages.findLast((message) => message.role !== "system");
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-engine-http-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("auth helpers manage 0o600 token, timing-safe bearer verification, state PID guard, and local connection", async () => {
  await withTempDir(async (dir) => {
    const tokenFile = join(dir, "engine.token");
    const token1 = await ensureAuthToken(tokenFile);
    assert.equal(token1.length, 64);
    const token2 = await ensureAuthToken(tokenFile);
    assert.equal(token2, token1);
    assert.equal(await readAuthToken(tokenFile), token1);

    if (process.platform !== "win32") {
      const info = await stat(tokenFile);
      assert.equal(info.mode & 0o777, 0o600);
    }

    assert.equal(verifyBearerToken(`Bearer ${token1}`, token1), true);
    assert.equal(verifyBearerToken(`bearer  ${token1}`, token1), true);
    assert.equal(verifyBearerToken(`Basic ${token1}`, token1), false);
    assert.equal(verifyBearerToken(`Bearer ${token1.slice(0, -1)}x`, token1), false);
    assert.equal(verifyBearerToken(undefined, token1), false);

    const stateFile = join(dir, "engine.json");
    const state = {
      pid: 99999,
      host: "127.0.0.1",
      port: 4173,
      url: "http://127.0.0.1:4173",
      protocolVersion: 1,
      engineVersion: "0.0.1",
      startedAt: 1000,
    };
    await writeEngineState(stateFile, state);
    assert.deepEqual(await readEngineState(stateFile), state);

    await removeEngineState(stateFile, 11111);
    assert.deepEqual(await readEngineState(stateFile), state);

    const local = await connectLocalEngine({ EEVEE_HOME: dir });
    assert.equal(local.url, state.url);
    assert.equal(local.token, token1);

    const override = await connectLocalEngine({
      EEVEE_HOME: dir,
      EEVEE_URL: "http://127.0.0.1:9999",
      EEVEE_TOKEN: "override-token",
    });
    assert.equal(override.url, "http://127.0.0.1:9999");
    assert.equal(override.token, "override-token");

    await removeEngineState(stateFile, 99999);
    assert.equal(await readEngineState(stateFile), undefined);
  });
});

test("startEngineHttpServer rejects non-127.0.0.1 hosts and enforces bearer auth on every route", async () => {
  await withTempDir(async (dir) => {
    const engine = await Engine.open({ dataDir: dir });
    let shutdownRequests = 0;
    try {
      for (const badHost of ["0.0.0.0", "::", "localhost", "192.168.1.10"]) {
        await assert.rejects(
          startEngineHttpServer(engine, { host: badHost, port: 0, token: "abc" }),
          /127\.0\.0\.1/,
        );
      }

      await assert.rejects(
        startForegroundEngine({ dataDir: dir, host: "0.0.0.0", port: 0 }),
        /127\.0\.0\.1/,
      );

      const server = await startEngineHttpServer(engine, {
        port: 0,
        token: "secret-token",
        onShutdown: () => {
          shutdownRequests += 1;
        },
      });
      try {
        const routes: [string, string][] = [
          ["GET", "/health"],
          ["POST", "/shutdown"],
          ["GET", "/projects"],
          ["POST", "/projects"],
          ["GET", "/boards/stream"],
          ["GET", "/projects/demo"],
          ["GET", "/projects/demo/tasks"],
          ["POST", "/projects/demo/conversations/router/messages"],
          ["GET", "/projects/demo/board"],
          ["GET", "/projects/demo/board/stream"],
          ["GET", "/projects/demo/conversations/router/stream"],
        ];

        for (const [method, path] of routes) {
          const unauth = await fetch(`${server.url}${path}`, { method });
          assert.equal(unauth.status, 401, `expected 401 for ${method} ${path} without auth`);
          assert.equal(unauth.headers.get("www-authenticate"), "Bearer");
          const problem = parseWithSchema(ProblemSchema, await unauth.json());
          assert.equal(problem.code, "unauthorized");

          const wrong = await fetch(`${server.url}${path}`, {
            method,
            headers: { Authorization: "Bearer wrong-token" },
          });
          assert.equal(wrong.status, 401, `expected 401 for ${method} ${path} with wrong token`);
          parseWithSchema(ProblemSchema, await wrong.json());
        }

        const client = new EeveeClient({ baseUrl: server.url, token: "secret-token" });
        assert.deepEqual(await client.shutdown(), { ok: true });
        await waitFor(() => shutdownRequests === 1, "authenticated shutdown callback");
      } finally {
        await server.close();
      }
    } finally {
      await engine.close();
    }
  });
});

test("HTTP server validates request bodies/queries and maps 404/409 errors to Problem", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const workspace = join(dir, "ws");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let releaseFirstRun: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let startedGate: (() => void) | undefined;
    const firstRunStarted = new Promise<void>((resolve) => {
      startedGate = resolve;
    });

    faux.setResponses([
      async () => {
        startedGate?.();
        await firstRunGate;
        return fauxAssistantMessage("done");
      },
      () => fauxAssistantMessage("second"),
    ]);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const auth = { Authorization: `Bearer ${foreground.token}` };
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });

      // Malformed JSON -> 400 Problem
      const badJsonRes = await fetch(`${foreground.url}/projects`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: "{bad",
      });
      assert.equal(badJsonRes.status, 400);
      parseWithSchema(ProblemSchema, await badJsonRes.json());

      // Invalid schema -> 400 Problem
      const badSchemaRes = await fetch(`${foreground.url}/projects`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaces: [] }),
      });
      assert.equal(badSchemaRes.status, 400);
      parseWithSchema(ProblemSchema, await badSchemaRes.json());

      // Oversized > 2 MiB body -> 413 Problem
      const hugeRes = await fetch(`${foreground.url}/projects`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaces: [workspace], memory: "x".repeat(2 * 1024 * 1024 + 64) }),
      });
      assert.equal(hugeRes.status, 413);
      assert.equal(parseWithSchema(ProblemSchema, await hugeRes.json()).code, "payload_too_large");

      // Unknown project -> 404 Problem (including SSE routes BEFORE headers)
      await assert.rejects(
        client.getProject("missing"),
        (error: unknown) => error instanceof EeveeApiError && error.status === 404,
      );
      const boardStreamMissing = await fetch(`${foreground.url}/projects/missing/board/stream`, {
        headers: auth,
      });
      assert.equal(boardStreamMissing.status, 404);
      assert.ok(boardStreamMissing.headers.get("content-type")?.includes("application/json"));
      parseWithSchema(ProblemSchema, await boardStreamMissing.json());

      const convStreamMissing = await fetch(
        `${foreground.url}/projects/missing/conversations/router/stream`,
        { headers: auth },
      );
      assert.equal(convStreamMissing.status, 404);
      parseWithSchema(ProblemSchema, await convStreamMissing.json());

      // Create real project
      const created = await client.createProject({ workspaces: [workspace], title: "App" });
      parseWithSchema(CreateProjectResponseSchema, created);
      const projectId = created.project.id;

      // Invalid query params on conversation stream -> 400 Problem
      const badQueryRes = await fetch(
        `${foreground.url}/projects/${projectId}/conversations/router/stream?from=0`,
        { headers: auth },
      );
      assert.equal(badQueryRes.status, 400);
      parseWithSchema(ProblemSchema, await badQueryRes.json());

      const badMinMaxRes = await fetch(
        `${foreground.url}/projects/${projectId}/conversations/router/stream?min=10&max=5`,
        { headers: auth },
      );
      assert.equal(badMinMaxRes.status, 400);
      parseWithSchema(ProblemSchema, await badMinMaxRes.json());

      // Unknown worker -> 404 Problem on messages and stream
      await assert.rejects(
        client.sendMessage(projectId, "w99", { text: "hi" }),
        (error: unknown) =>
          error instanceof EeveeApiError &&
          error.status === 404 &&
          error.problem.code === "worker_not_found",
      );
      const workerStreamMissing = await fetch(
        `${foreground.url}/projects/${projectId}/conversations/w99/stream`,
        { headers: auth },
      );
      assert.equal(workerStreamMissing.status, 404);
      parseWithSchema(ProblemSchema, await workerStreamMissing.json());

      // Busy conversation with whenBusy="reject" -> 409 Problem
      const firstSend = await client.sendMessage(projectId, "router", { text: "start slow run" });
      parseWithSchema(SendMessageResponseSchema, firstSend);
      await firstRunStarted;

      await assert.rejects(
        client.sendMessage(projectId, "router", { text: "conflict", whenBusy: "reject" }),
        (error: unknown) =>
          error instanceof EeveeApiError &&
          error.status === 409 &&
          error.problem.code === "conversation_busy",
      );

      releaseFirstRun?.();
      const handle = await foreground.engine.openProject(projectId);
      await handle.root.waitForIdle(BACKGROUND_CONTEXT);

      // Closed worker -> 409 Problem
      const closeBrain: FauxResponseFactory = (ctx) => {
        const last = lastMessage(ctx);
        if (last?.role === "user") {
          const text = messageText(last);
          if (text.includes("spawn-and-close")) {
            return fauxAssistantMessage(
              [fauxToolCall("spawn_worker", { name: "temp", prompt: "do tiny task" })],
              { stopReason: "toolUse" },
            );
          }
          if (text.includes("tiny done")) {
            return fauxAssistantMessage(
              [fauxToolCall("stop_worker", { workerId: "w1", action: "close" })],
              { stopReason: "toolUse" },
            );
          }
          if (text.includes("do tiny task")) {
            return fauxAssistantMessage("tiny done");
          }
        }
        if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
          return fauxAssistantMessage("spawned");
        }
        if (last?.role === "toolResult" && last.toolName === "stop_worker") {
          return fauxAssistantMessage("closed w1");
        }
        return fauxAssistantMessage("ok");
      };
      faux.setResponses(Array.from({ length: 15 }, () => closeBrain));
      await client.sendMessage(projectId, "router", { text: "spawn-and-close" });
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        return board.workers.some((w) => w.id === "w1" && w.status === "closed");
      }, "worker w1 to close");

      await assert.rejects(
        client.sendMessage(projectId, "w1", { text: "too late" }),
        (error: unknown) =>
          error instanceof EeveeApiError &&
          error.status === 409 &&
          error.problem.code === "worker_closed",
      );
    } finally {
      await foreground.close();
      assert.equal(await readEngineState(foreground.layout.stateFile), undefined);
    }
  });
});

test("HTTP endpoints satisfy protocol contracts, stream Board and Conversation SSE, and persist across SQLite reopen", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "workspace-one");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("start work")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", {
                name: "helper",
                prompt: "helper job",
                ticketTitle: "Help out",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("worker completed helper job")) {
          return fauxAssistantMessage("all work complete");
        }
        if (text.includes("helper job")) {
          return fauxAssistantMessage("worker completed helper job");
        }
      }
      if (last?.role === "toolResult" && last.toolName === "spawn_worker") {
        return fauxAssistantMessage("delegated to helper");
      }
      return fauxAssistantMessage("acknowledged");
    };
    faux.setResponses(Array.from({ length: 20 }, () => brain));

    let projectId: string;
    let lastEntryIdFromStream: number | undefined;

    // First Engine lifetime: create project, stream conversation + board, run router + worker
    const first = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: first.url, token: first.token });

      const health = await client.health();
      parseWithSchema(HealthResponseSchema, health);
      assert.equal(health.ok, true);
      assert.equal(health.pid, process.pid);

      const created = await client.createProject({
        workspaces: [ws1],
        title: "My App",
        memory: "Prefer concise output",
      });
      parseWithSchema(CreateProjectResponseSchema, created);
      projectId = created.project.id;

      // Duplicate project title gets unique slug
      const dup = await client.createProject({ workspaces: [ws1], title: "My App" });
      assert.notEqual(dup.project.id, projectId);

      const listed = await client.listProjects();
      parseWithSchema(ListProjectsResponseSchema, listed);
      assert.equal(listed.projects.length, 2);

      const fetched = await client.getProject(projectId);
      parseWithSchema(GetProjectResponseSchema, fetched);
      assert.equal(fetched.project.memory, "Prefer concise output");

      // Start Board SSE + Conversation SSE
      const boardAbort = new AbortController();
      const convAbort = new AbortController();
      const boardEvents: BoardStreamEvent[] = [];
      const convEvents: ConversationStreamEvent[] = [];

      const boardLoop = (async () => {
        for await (const evt of client.streamBoard(projectId, { signal: boardAbort.signal })) {
          boardEvents.push(evt);
        }
      })();

      const convLoop = (async () => {
        for await (const evt of client.streamConversation(projectId, "router", {
          signal: convAbort.signal,
        })) {
          convEvents.push(evt);
          if (evt.type === "snapshot" || evt.type === "patch") {
            parseWithSchema(ConversationViewPayloadSchema, evt.view);
            const last = evt.view.entries.at(-1);
            if (last !== undefined) lastEntryIdFromStream = last.id;
          }
        }
      })();

      const sent = await client.sendMessage(projectId, "router", { text: "start work" });
      parseWithSchema(SendMessageResponseSchema, sent);

      await waitFor(() => {
        const hasRouterFinal = convEvents.some(
          (evt) =>
            (evt.type === "snapshot" || evt.type === "patch") &&
            JSON.stringify(evt.view.entries).includes("all work complete"),
        );
        const hasIdleWorker = boardEvents.some(
          (evt) =>
            evt.type === "board" &&
            evt.board.workers.some((w) => w.id === "w1" && w.status === "idle"),
        );
        return hasRouterFinal && hasIdleWorker;
      }, "SSE conversation and board updates");

      const board = await client.getBoard(projectId);
      parseWithSchema(BoardViewSchema, board);
      assert.equal(board.workers.length, 1);
      assert.equal(board.tickets.length, 1);

      boardAbort.abort();
      convAbort.abort();
      await Promise.all([boardLoop, convLoop]);

      // Verify server.close() cleanly terminates an open SSE stream with reason="closed"
      const closingEvents: ConversationStreamEvent[] = [];
      const closingStream = (async () => {
        for await (const evt of client.streamConversation(projectId, "router")) {
          closingEvents.push(evt);
        }
      })();
      await waitFor(() => closingEvents.length >= 1, "initial snapshot before server close");
      await first.close();
      await closingStream;
      const lastClosingEvent = closingEvents.at(-1);
      assert.equal(lastClosingEvent?.type, "end");
      if (lastClosingEvent?.type === "end") {
        assert.equal(lastClosingEvent.reason, "closed");
      }
    } finally {
      await first.close();
    }

    // Reopen Engine on same dataDir -> SQLite persists projects, kv, and conversation entries
    const store = EngineStore.open(join(home, "engine.sqlite"));
    const customSchema = obj({ enabled: bool() });
    assert.equal(store.hasKv("custom"), false);
    store.setKv("custom", { enabled: true });
    assert.equal(store.hasKv("custom"), true);
    assert.deepEqual(store.getKvParsed("custom", customSchema), { enabled: true });
    assert.equal(store.deleteKv("custom"), true);
    assert.equal(store.hasKv("custom"), false);
    assert.equal(store.getKvParsed("custom", customSchema), undefined);
    store.close();
    store.close(); // idempotent close

    const reopened = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: reopened.url, token: reopened.token });
      const listed = await client.listProjects();
      assert.equal(listed.projects.length, 2);

      // Verify Last-Event-ID resume skips already-seen entries
      assert.ok(lastEntryIdFromStream !== undefined);
      const resumedAbort = new AbortController();
      const resumedEvents: ConversationStreamEvent[] = [];
      const resumedLoop = (async () => {
        for await (const evt of client.streamConversation(projectId, "router", {
          lastEventId: lastEntryIdFromStream,
          signal: resumedAbort.signal,
        })) {
          resumedEvents.push(evt);
          if (evt.type === "snapshot") resumedAbort.abort();
        }
      })();
      await resumedLoop;
      assert.equal(resumedEvents[0]?.type, "snapshot");
      if (resumedEvents[0]?.type === "snapshot") {
        assert.equal(resumedEvents[0].view.entries.length, 0);
        assert.equal(resumedEvents[0].view.before, lastEntryIdFromStream);
      }

      const boardAfterReopen = await client.getBoard(projectId);
      assert.equal(boardAfterReopen.workers.length, 1);
      assert.equal(boardAfterReopen.workers[0]?.id, "w1");
      assert.equal(boardAfterReopen.workers[0]?.status, "idle");
    } finally {
      await reopened.close();
    }
  });
});

test("RouteTrie enforces static-before-param precedence regardless of registration order and preserves 405 Allow headers", async () => {
  const trie = new RouteTrie([
    route("GET", "/providers/:providerId", () => {}),
    route("PATCH", "/providers/:providerId", () => {}),
    route("DELETE", "/providers/:providerId", () => {}),
    route("POST", "/providers/:providerId/probe", () => {}),
    route("GET", "/providers/catalog", () => {}),
    route("POST", "/providers/probe", () => {}),
  ]);

  const catalogMatch = trie.matchPath(["providers", "catalog"]);
  assert.ok(catalogMatch !== undefined);
  assert.equal(catalogMatch.allowHeader, "GET");
  assert.deepEqual(catalogMatch.methods.get("GET")?.pattern, ["providers", "catalog"]);
  assert.equal(catalogMatch.methods.get("POST"), undefined);

  const probeMatch = trie.matchPath(["providers", "probe"]);
  assert.ok(probeMatch !== undefined);
  assert.equal(probeMatch.allowHeader, "POST");
  assert.deepEqual(probeMatch.methods.get("POST")?.pattern, ["providers", "probe"]);
  assert.equal(probeMatch.methods.get("GET"), undefined);

  const customMatch = trie.matchPath(["providers", "custom"]);
  assert.ok(customMatch !== undefined);
  assert.equal(customMatch.allowHeader, "GET, PATCH, DELETE");
  assert.deepEqual(customMatch.methods.get("GET")?.pattern, ["providers", ":providerId"]);

  const nestedBacktrack = trie.matchPath(["providers", "catalog", "probe"]);
  assert.ok(nestedBacktrack !== undefined);
  assert.equal(nestedBacktrack.allowHeader, "POST");
  assert.deepEqual(nestedBacktrack.methods.get("POST")?.pattern, [
    "providers",
    ":providerId",
    "probe",
  ]);

  assert.equal(trie.matchPath(["providers", "catalog", "unknown"]), undefined);

  await withTempDir(async (dir) => {
    const engine = await Engine.open({ dataDir: dir });
    const server = await startEngineHttpServer(engine, {
      port: 0,
      token: "trie-http-token",
      webDistDir: false,
    });
    try {
      const headers = { Authorization: "Bearer trie-http-token" };
      const catalog405 = await fetch(`${server.url}/providers/catalog`, {
        method: "POST",
        headers,
      });
      assert.equal(catalog405.status, 405);
      assert.equal(catalog405.headers.get("allow"), "GET");
      parseWithSchema(ProblemSchema, await catalog405.json());

      const probe405 = await fetch(`${server.url}/providers/probe`, {
        method: "GET",
        headers,
      });
      assert.equal(probe405.status, 405);
      assert.equal(probe405.headers.get("allow"), "POST");
      parseWithSchema(ProblemSchema, await probe405.json());
    } finally {
      await server.close();
      await engine.close();
    }
  });
});

test("decodeCursor enforces strict Cursor shape and rejects invalid payloads", () => {
  const withOrder = encodeCursor({ after: 42, order: "descending" });
  assert.deepEqual(decodeCursor(withOrder), { after: 42, order: "descending" });

  const legacy = Buffer.from(JSON.stringify({ after: 7 }), "utf8").toString("base64url");
  assert.deepEqual(decodeCursor(legacy), { after: 7 });

  const badPayloads: unknown[] = [
    null,
    [],
    "cursor",
    123,
    {},
    { order: "ascending" },
    { after: -1, order: "ascending" },
    { after: 1.5, order: "ascending" },
    { after: 9007199254740992, order: "ascending" },
    { after: "1", order: "ascending" },
    { after: 1, order: "sideways" },
    { after: 1, order: "ascending", extra: true },
  ];
  for (const payload of badPayloads) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    assert.throws(
      () => decodeCursor(encoded),
      (err: unknown) => err instanceof EngineError && err.status === 400,
    );
  }
  assert.throws(
    () => decodeCursor(""),
    (err: unknown) => err instanceof EngineError && err.status === 400,
  );
  assert.throws(
    () => decodeCursor("not!base64"),
    (err: unknown) => err instanceof EngineError && err.status === 400,
  );
});

test("HTTP maps StoreValidationError to 400 while surfacing genuine SQLite failures as 500", async () => {
  await withTempDir(async (dir) => {
    const engine = await Engine.open({ dataDir: dir });
    const server = await startEngineHttpServer(engine, {
      port: 0,
      token: "store-err-token",
      webDistDir: false,
    });
    try {
      const client = new EeveeClient({ baseUrl: server.url, token: "store-err-token" });

      // Domain validation errors in store -> 400 invalid_request
      await assert.rejects(
        client.createProject({ workspaces: ["   "], title: "Valid" }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "invalid_request",
      );

      const created = await client.createProject({ workspaces: [dir], title: "Good" });
      await assert.rejects(
        client.updateProject(created.project.id, { title: "   " }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "invalid_request",
      );

      // Genuine SQLite failure (store closed unexpectedly) -> 500 internal_error, NOT masked as 400
      engine.store.close();
      await assert.rejects(
        client.createProject({ workspaces: [dir], title: "After DB Close" }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 500 &&
          err.problem.code === "internal_error",
      );
      await assert.rejects(
        client.updateProject(created.project.id, { title: "After DB Close" }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 500 &&
          err.problem.code === "internal_error",
      );
    } finally {
      await server.close();
      await engine.close();
    }
  });
});

test("GET /projects/:projectId/tasks aggregates, sorts deterministically, and preserves active tasks under limit", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const quickCmd = "echo done";
    const holdCmd = "echo holding && sleep 60";

    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      if (last?.role === "user") {
        const text = messageText(last);
        if (text.includes("spawn-two")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("spawn_worker", { name: "alpha", prompt: "alpha-init" }),
              fauxToolCall("spawn_worker", { name: "beta", prompt: "beta-init" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-finished-1")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: quickCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-finished-2")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: quickCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
        if (text.includes("run-active")) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: holdCmd, background: true })],
            { stopReason: "toolUse" },
          );
        }
      }
      if (last?.role === "toolResult") {
        return fauxAssistantMessage("done-step");
      }
      return fauxAssistantMessage("ack");
    };
    faux.setResponses(Array.from({ length: 60 }, () => brain));

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "ProjectTasks" }))
        .project.id;

      await client.sendMessage(projectId, "router", { text: "spawn-two" });
      await waitFor(async () => {
        const board = await client.getBoard(projectId);
        return board.workers.length === 2 && board.workers.every((w) => w.status === "idle");
      }, "both workers w1 and w2 idle");

      // Finished tasks on w1 and w2
      await client.sendMessage(projectId, "w1", { text: "run-finished-1" });
      await waitFor(async () => {
        const res = await client.listWorkerTasks(projectId, "w1", { status: "finished" });
        return res.tasks.length >= 1;
      }, "w1 finished task-1");

      await client.sendMessage(projectId, "w2", { text: "run-finished-2" });
      await waitFor(async () => {
        const res = await client.listWorkerTasks(projectId, "w2", { status: "finished" });
        return res.tasks.length >= 1;
      }, "w2 finished task-1");

      // Active tasks on both w1 and w2
      await client.sendMessage(projectId, "w1", { text: "run-active" });
      await client.sendMessage(projectId, "w2", { text: "run-active" });
      await waitFor(async () => {
        const res = await client.listProjectTasks(projectId, { status: "active" });
        return res.tasks.length === 2;
      }, "2 active tasks across w1 and w2");

      const all = await client.listProjectTasks(projectId);
      parseWithSchema(ListProjectTasksResponseSchema, all);
      assert.equal(all.tasks.length, 4);

      const activeOnly = await client.listProjectTasks(projectId, { status: "active" });
      assert.equal(activeOnly.tasks.length, 2);
      assert.deepEqual(activeOnly.tasks.map((t) => t.workerId).sort(), ["w1", "w2"]);

      const finishedOnly = await client.listProjectTasks(projectId, { status: "finished" });
      assert.equal(finishedOnly.tasks.length, 2);

      // Verify deterministic sort order (startedAt asc, then workerId, then id) within each bucket
      const sortedCheck = [...finishedOnly.tasks].sort((a, b) => {
        if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
        if (a.workerId !== b.workerId) return a.workerId < b.workerId ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      assert.deepEqual(finishedOnly.tasks, sortedCheck);

      // status="all" with limit=1 preserves ALL active tasks AND returns only last 1 finished task
      const limitedAll = await client.listProjectTasks(projectId, { status: "all", limit: 1 });
      assert.equal(limitedAll.tasks.length, 3);
      assert.deepEqual(limitedAll.tasks.slice(0, 2), activeOnly.tasks);
      assert.deepEqual(limitedAll.tasks.slice(2), finishedOnly.tasks.slice(-1));

      // status="active" with limit=1 bounds active tasks to 1
      const limitedActive = await client.listProjectTasks(projectId, {
        status: "active",
        limit: 1,
      });
      assert.equal(limitedActive.tasks.length, 1);

      // Query validation & missing project checks
      await assert.rejects(
        client.listProjectTasks(projectId, { limit: 0 }),
        (err: unknown) => err instanceof EeveeApiError && err.status === 400,
      );
      await assert.rejects(
        client.listProjectTasks("missing-project"),
        (err: unknown) => err instanceof EeveeApiError && err.status === 404,
      );
    } finally {
      await foreground.close();
    }
  });
});
