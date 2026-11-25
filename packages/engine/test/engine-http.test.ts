import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
  ProblemSchema,
  parseWithSchema,
  SendMessageResponseSchema,
} from "@eevee/protocol";
import {
  connectLocalEngine,
  Engine,
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

      const server = await startEngineHttpServer(engine, { port: 0, token: "secret-token" });
      try {
        const routes: [string, string][] = [
          ["GET", "/health"],
          ["GET", "/projects"],
          ["POST", "/projects"],
          ["GET", "/projects/demo"],
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
    store.setKv("custom", { enabled: true });
    assert.deepEqual(store.getKv("custom"), { enabled: true });
    assert.equal(store.deleteKv("custom"), true);
    assert.equal(store.getKv("custom"), undefined);
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
