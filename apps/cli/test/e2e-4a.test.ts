import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  BoardViewSchema,
  ConversationSnapshotEventSchema,
  ConversationViewPayloadSchema,
  CreateProjectResponseSchema,
  EeveeClient,
  GetProjectResponseSchema,
  HealthResponseSchema,
  ListProjectsResponseSchema,
  ProblemSchema,
  parseWithSchema,
  SendMessageResponseSchema,
} from "@eevee/protocol";
import { lastUserOrToolMessage, type ScriptedOpenAiTurn, startE2eFixture } from "./e2e-harness.ts";

test("Slice 4A E2E: rejects invalid auth, runs Router -> Worker -> Handoff -> Board via real Engine & CLI", async () => {
  const fixture = await startE2eFixture({
    resolveTurn: (request): ScriptedOpenAiTurn => {
      const last = lastUserOrToolMessage(request);
      if (last.role === "user") {
        if (last.text.includes("Worker builder") && last.text.includes("Created hello.txt")) {
          return {
            textChunks: ["Worker finished! ", "Result is ready."],
            chunkDelayMs: 65,
          };
        }
        if (last.text.includes("Create hello.txt")) {
          return {
            toolCalls: [
              {
                name: "write",
                arguments: { path: "hello.txt", content: "hello from e2e worker" },
              },
            ],
          };
        }
        if (last.text.includes("Build the greeting")) {
          return {
            toolCalls: [
              {
                name: "spawn_worker",
                arguments: {
                  name: "builder",
                  prompt: "Create hello.txt with a greeting.",
                  ticketTitle: "Build greeting",
                },
              },
            ],
          };
        }
      }

      if (last.role === "tool") {
        if (last.text.includes("Queued w1")) {
          return {
            textChunks: ["Delegating ", "work to builder."],
            chunkDelayMs: 65,
          };
        }
        if (last.text.includes("hello.txt") || last.text.includes("Successfully wrote")) {
          return {
            textChunks: ["Created hello.txt cleanly."],
          };
        }
      }

      throw new Error(`Unexpected scripted OpenAI request: ${JSON.stringify(last)}`);
    },
  });

  try {
    const noAuthRes = await fetch(`${fixture.engineUrl}/health`);
    assert.equal(noAuthRes.status, 401);
    assert.equal(noAuthRes.headers.get("www-authenticate"), "Bearer");
    parseWithSchema(ProblemSchema, await noAuthRes.json());

    const badAuthRes = await fetch(`${fixture.engineUrl}/projects`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(badAuthRes.status, 401);
    parseWithSchema(ProblemSchema, await badAuthRes.json());

    const health = await fixture.client.health();
    parseWithSchema(HealthResponseSchema, health);
    assert.equal(health.ok, true);

    const createRes = await fixture.runCli([
      "project",
      "create",
      fixture.workspaceDir,
      "--title",
      "E2E Demo",
      "--memory",
      "Always delegate file writes.",
      "--router-model",
      "mock/test-model",
      "--worker-model",
      "mock/test-model",
      "--json",
    ]);
    assert.equal(createRes.code, 0, createRes.stderr);
    const created = parseWithSchema(CreateProjectResponseSchema, JSON.parse(createRes.stdout));
    const projectId = created.project.id;
    assert.equal(created.project.title, "E2E Demo");

    const listRes = await fixture.runCli(["project", "list", "--json"]);
    assert.equal(listRes.code, 0, listRes.stderr);
    const listed = parseWithSchema(ListProjectsResponseSchema, JSON.parse(listRes.stdout));
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0]?.id, projectId);

    const fetched = await fixture.client.getProject(projectId);
    parseWithSchema(GetProjectResponseSchema, fetched);
    assert.equal(fetched.project.id, projectId);

    const streamAbort = new AbortController();
    const clientEvents: unknown[] = [];
    const clientWatchLoop = (async () => {
      const client = new EeveeClient({ baseUrl: fixture.engineUrl, token: fixture.engineToken });
      for await (const event of client.streamConversation(projectId, "router", {
        signal: streamAbort.signal,
      })) {
        clientEvents.push(event);
        if (event.type === "snapshot" || event.type === "patch") {
          parseWithSchema(ConversationViewPayloadSchema, event.view);
        }
      }
    })();

    const boardAbort = new AbortController();
    const boardStreamEvents: unknown[] = [];
    const boardStreamLoop = (async () => {
      for await (const event of fixture.client.streamBoard(projectId, {
        signal: boardAbort.signal,
      })) {
        boardStreamEvents.push(event);
        if (event.type === "board") {
          parseWithSchema(BoardViewSchema, event.board);
        }
      }
    })();

    const watchProc = fixture.spawnCli(["watch", projectId]);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const sendRes = await fixture.runCli(["send", projectId, "Build the greeting file.", "--json"]);
    assert.equal(sendRes.code, 0, sendRes.stderr);
    const sent = parseWithSchema(SendMessageResponseSchema, JSON.parse(sendRes.stdout));
    assert.ok(sent.submissionId >= 1);

    const watchedText = await watchProc.waitForStdout(
      (stdout) =>
        stdout.includes("Delegating work to builder.") &&
        stdout.includes("Worker finished! Result is ready."),
      20_000,
    );
    await watchProc.stop();

    assert.equal(watchedText.split("Delegating work to builder.").length - 1, 1);
    assert.equal(watchedText.split("Worker finished! Result is ready.").length - 1, 1);
    assert.ok(watchedText.includes("[user] Build the greeting file."));
    assert.ok(watchedText.includes("[toolCall] spawn_worker"));

    const written = await readFile(join(fixture.workspaceDir, "hello.txt"), "utf8");
    assert.equal(written, "hello from e2e worker");

    const boardJsonRes = await fixture.runCli(["board", projectId, "--json"]);
    assert.equal(boardJsonRes.code, 0, boardJsonRes.stderr);
    const board = parseWithSchema(BoardViewSchema, JSON.parse(boardJsonRes.stdout));
    assert.equal(board.workers.length, 1);
    assert.equal(board.workers[0]?.id, "w1");
    assert.equal(board.workers[0]?.name, "builder");
    assert.equal(board.workers[0]?.status, "idle");
    assert.equal(board.tickets.length, 1);
    assert.equal(board.tickets[0]?.id, "t1");
    assert.equal(board.tickets[0]?.title, "Build greeting");
    assert.equal(board.tickets[0]?.status, "open");

    const boardHumanRes = await fixture.runCli(["board", projectId]);
    assert.equal(boardHumanRes.code, 0, boardHumanRes.stderr);
    assert.ok(boardHumanRes.stdout.includes('w1 "builder" [idle]'));
    assert.ok(boardHumanRes.stdout.includes("t1 [open] (w1) Build greeting"));

    const watchJsonProc = fixture.spawnCli(["watch", projectId, "--from", "1", "--json"]);
    const watchNdjson = await watchJsonProc.waitForStdout((out) => out.includes("\n"), 10_000);
    await watchJsonProc.stop();
    const firstWatchLine = JSON.parse(watchNdjson.trim().split("\n")[0] ?? "{}") as {
      type?: string;
      view?: unknown;
    };
    assert.equal(firstWatchLine.type, "snapshot");
    parseWithSchema(ConversationSnapshotEventSchema, { view: firstWatchLine.view });

    const boardWatchProc = fixture.spawnCli(["board", projectId, "--watch", "--json"]);
    const boardNdjson = await boardWatchProc.waitForStdout((out) => out.includes("\n"), 10_000);
    await boardWatchProc.stop();
    const firstBoardLine = JSON.parse(boardNdjson.trim().split("\n")[0] ?? "{}");
    parseWithSchema(BoardViewSchema, firstBoardLine);

    streamAbort.abort();
    boardAbort.abort();
    await Promise.all([clientWatchLoop, boardStreamLoop]);
    assert.ok(clientEvents.length >= 3);
    assert.ok(boardStreamEvents.length >= 2);
  } finally {
    await fixture.cleanup();
  }
});
