import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnswerQuestionResponseSchema,
  BoardViewSchema,
  ConversationSnapshotEventSchema,
  CreateProjectResponseSchema,
  KillWorkerTaskResponseSchema,
  ListEntriesResponseSchema,
  OkResponseSchema,
  parseWithSchema,
  ReadWorkerTaskResponseSchema,
  SendMessageResponseSchema,
} from "@eevee/protocol";
import {
  lastUserOrToolMessage,
  type ScriptedOpenAiTurn,
  startE2eFixture,
  waitFor,
} from "./e2e-harness.ts";

test("Slice 4B E2E: ask_user -> answer -> watch w1 -> bg task -> direct send -> interrupt -> retry -> task read/kill", async () => {
  const nodeBin = JSON.stringify(process.execPath.replace(/\\/g, "/"));
  const longTaskCmd = `${nodeBin} -e 'let i=0; const t=setInterval(()=>{ i++; process.stdout.write("line-"+i+"\\n"); }, 50); setTimeout(()=>clearInterval(t), 20000);'`;

  let slowAttempt = 0;

  const fixture = await startE2eFixture({
    resolveTurn: (request): ScriptedOpenAiTurn => {
      const last = lastUserOrToolMessage(request);
      if (last.role === "user") {
        if (last.text.includes("Plan deployment")) {
          return {
            toolCalls: [
              {
                name: "ask_user",
                arguments: {
                  questions: [
                    {
                      question: "Target environment?",
                      options: ["staging", "prod"],
                      recommended: "staging",
                    },
                    { question: "Region?" },
                  ],
                },
              },
            ],
          };
        }
        if (last.text.includes("User answered question q1")) {
          return {
            toolCalls: [
              {
                name: "spawn_worker",
                arguments: {
                  name: "ops",
                  prompt: "Start long monitor task in background.",
                  ticketTitle: "Monitor deployment",
                },
              },
            ],
          };
        }
        if (last.text.includes("Start long monitor task")) {
          return {
            toolCalls: [
              {
                name: "bash",
                arguments: {
                  command: longTaskCmd,
                  background: true,
                },
              },
            ],
          };
        }
        if (last.text.includes("Run slow check now")) {
          slowAttempt += 1;
          if (slowAttempt === 1) {
            return {
              textChunks: [
                "Starting slow check... ",
                ...Array.from({ length: 35 }, (_, idx) => `step-${idx + 1} `),
              ],
              chunkDelayMs: 100,
            };
          }
          return {
            textChunks: ["Slow check resumed and completed!"],
          };
        }
      }

      if (last.role === "tool") {
        if (last.text.includes("Recorded user question q1")) {
          return { textChunks: ["Awaiting user confirmation."] };
        }
        if (last.text.includes("Queued w1")) {
          return { textChunks: ["Spawned worker ops."] };
        }
        if (last.text.includes("Started background task task-1")) {
          return { textChunks: ["Monitor task-1 started."] };
        }
      }

      throw new Error(`Unexpected scripted OpenAI request: ${JSON.stringify(last)}`);
    },
  });

  try {
    // 1. Create project
    const createRes = await fixture.runCli([
      "project",
      "create",
      fixture.workspaceDir,
      "--title",
      "Ops Demo",
      "--router-model",
      "mock/test-model",
      "--worker-model",
      "mock/test-model",
      "--json",
    ]);
    assert.equal(createRes.code, 0, createRes.stderr);
    const created = parseWithSchema(CreateProjectResponseSchema, JSON.parse(createRes.stdout));
    const projectId = created.project.id;

    // 2. Router calls ask_user -> eevee board shows unanswered q1
    const sendRouter = await fixture.runCli([
      "send",
      projectId,
      "Plan deployment and confirm target",
      "--json",
    ]);
    assert.equal(sendRouter.code, 0, sendRouter.stderr);
    parseWithSchema(SendMessageResponseSchema, JSON.parse(sendRouter.stdout));

    await waitFor(async () => {
      const boardRes = await fixture.runCli(["board", projectId, "--json"]);
      if (boardRes.code !== 0) return false;
      const board = parseWithSchema(BoardViewSchema, JSON.parse(boardRes.stdout));
      return board.questions.some((q) => q.id === "q1" && q.answeredAt === undefined);
    }, "board to show unanswered q1");

    const boardHuman = await fixture.runCli(["board", projectId]);
    assert.equal(boardHuman.code, 0, boardHuman.stderr);
    assert.ok(boardHuman.stdout.includes("Unanswered questions:"));
    assert.ok(boardHuman.stdout.includes("q1: Target environment?; Region?"));

    // 3. eevee answer q1 -> Router resumes and spawns Worker w1
    const answerRes = await fixture.runCli([
      "answer",
      projectId,
      "q1",
      "staging",
      "us-east-1",
      "--json",
    ]);
    assert.equal(answerRes.code, 0, answerRes.stderr);
    const answered = parseWithSchema(AnswerQuestionResponseSchema, JSON.parse(answerRes.stdout));
    assert.equal(answered.question.id, "q1");
    assert.deepEqual(answered.question.answers, ["staging", "us-east-1"]);

    await waitFor(async () => {
      const board = await fixture.client.getBoard(projectId);
      const w1 = board.workers.find((w) => w.id === "w1");
      return w1?.tasks.some((t) => t.id === "task-1" && t.status === "running") ?? false;
    }, "worker w1 to start background task-1");

    // 4. eevee watch <project> w1 observes Worker w1
    const watchW1 = fixture.spawnCli(["watch", projectId, "w1"]);
    await watchW1.waitForStdout((out) => out.includes("Monitor task-1 started."), 15_000);

    // 5. Direct message to w1 via eevee send --worker w1
    const sendW1 = await fixture.runCli([
      "send",
      projectId,
      "Run slow check now",
      "--worker",
      "w1",
      "--json",
    ]);
    assert.equal(sendW1.code, 0, sendW1.stderr);
    parseWithSchema(SendMessageResponseSchema, JSON.parse(sendW1.stdout));

    await watchW1.waitForStdout((out) => out.includes("Starting slow check..."), 15_000);

    // 6. Interrupt w1 mid-turn via eevee interrupt <project> w1; background task-1 must stay running!
    const interruptRes = await fixture.runCli(["interrupt", projectId, "w1", "--json"]);
    assert.equal(interruptRes.code, 0, interruptRes.stderr);
    parseWithSchema(OkResponseSchema, JSON.parse(interruptRes.stdout));

    await waitFor(async () => {
      const board = await fixture.client.getBoard(projectId);
      const w1 = board.workers.find((w) => w.id === "w1");
      const task1 = w1?.tasks.find((t) => t.id === "task-1");
      return task1?.status === "running" && w1?.status === "running";
    }, "task-1 to remain running after interrupt");

    // 7. Resume via eevee retry <project> w1
    const retryRes = await fixture.runCli(["retry", projectId, "w1", "--json"]);
    assert.equal(retryRes.code, 0, retryRes.stderr);
    parseWithSchema(SendMessageResponseSchema, JSON.parse(retryRes.stdout));

    await watchW1.waitForStdout((out) => out.includes("Slow check resumed and completed!"), 15_000);
    await watchW1.stop();

    // 8. Read background task output (including incremental --since-bytes)
    let firstRead = parseWithSchema(
      ReadWorkerTaskResponseSchema,
      JSON.parse(
        (
          await fixture.runCli([
            "task",
            "read",
            projectId,
            "w1",
            "task-1",
            "--mode",
            "head",
            "--bytes",
            "256",
            "--json",
          ])
        ).stdout,
      ),
    );
    await waitFor(async () => {
      const res = await fixture.runCli([
        "task",
        "read",
        projectId,
        "w1",
        "task-1",
        "--mode",
        "head",
        "--bytes",
        "256",
        "--json",
      ]);
      assert.equal(res.code, 0, res.stderr);
      firstRead = parseWithSchema(ReadWorkerTaskResponseSchema, JSON.parse(res.stdout));
      return (
        firstRead.output.text.includes("line-1\n") && firstRead.output.text.includes("line-2\n")
      );
    }, "task-1 to emit initial lines");

    const sinceOffset = firstRead.output.endByte;
    let incRead = firstRead;
    await waitFor(async () => {
      const res = await fixture.runCli([
        "task",
        "read",
        projectId,
        "w1",
        "task-1",
        "--since-bytes",
        String(sinceOffset),
        "--json",
      ]);
      assert.equal(res.code, 0, res.stderr);
      incRead = parseWithSchema(ReadWorkerTaskResponseSchema, JSON.parse(res.stdout));
      return incRead.output.endByte > sinceOffset;
    }, "incremental output beyond sinceOffset");
    assert.equal(incRead.output.fromByte, sinceOffset);
    assert.equal(incRead.output.text.includes("line-1\n"), false);

    const humanTaskRead = await fixture.runCli([
      "task",
      "read",
      projectId,
      "w1",
      "task-1",
      "--mode",
      "tail",
      "--bytes",
      "256",
    ]);
    assert.equal(humanTaskRead.code, 0, humanTaskRead.stderr);
    assert.ok(humanTaskRead.stdout.includes("Worker w1 task task-1 [running]"));

    // 9. Kill task-1 via eevee task kill and verify Router is NOT notified
    const routerEntriesBeforeKill = await fixture.client.listEntries(projectId, "router", {
      limit: 500,
    });
    const requestsBeforeKill = fixture.mockOpenAi.requests.length;

    const killRes = await fixture.runCli(["task", "kill", projectId, "w1", "task-1", "--json"]);
    assert.equal(killRes.code, 0, killRes.stderr);
    const killed = parseWithSchema(KillWorkerTaskResponseSchema, JSON.parse(killRes.stdout));
    assert.equal(killed.task.status, "killed");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const routerEntriesAfterKill = await fixture.client.listEntries(projectId, "router", {
      limit: 500,
    });
    assert.equal(routerEntriesAfterKill.entries.length, routerEntriesBeforeKill.entries.length);
    assert.equal(fixture.mockOpenAi.requests.length, requestsBeforeKill);

    const finalBoard = await fixture.client.getBoard(projectId);
    const w1Final = finalBoard.workers.find((w) => w.id === "w1");
    assert.equal(w1Final?.status, "idle");
    assert.equal(w1Final?.activeTaskCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("Slice 4B E2E: watch reconnect with lastEventId delivers only missed entries and listEntries paginates full history", async () => {
  const fixture = await startE2eFixture({
    resolveTurn: (request): ScriptedOpenAiTurn => {
      const last = lastUserOrToolMessage(request);
      if (last.role === "user") {
        if (last.text.includes("First turn")) {
          return { textChunks: ["Alpha response complete."] };
        }
        if (last.text.includes("Second turn")) {
          return { textChunks: ["Beta response complete."] };
        }
        if (last.text.includes("Third turn")) {
          return { textChunks: ["Gamma response complete."] };
        }
      }
      throw new Error(`Unexpected scripted OpenAI request: ${JSON.stringify(last)}`);
    },
  });

  try {
    const createRes = await fixture.runCli([
      "project",
      "create",
      fixture.workspaceDir,
      "--title",
      "Resume Demo",
      "--router-model",
      "mock/test-model",
      "--worker-model",
      "mock/test-model",
      "--json",
    ]);
    assert.equal(createRes.code, 0, createRes.stderr);
    const projectId = parseWithSchema(CreateProjectResponseSchema, JSON.parse(createRes.stdout))
      .project.id;

    // Turn 1 while watching via EeveeClient; record eventId when Alpha completes, then disconnect.
    const ac1 = new AbortController();
    let savedEventId: string | undefined;
    const firstStreamLoop = (async () => {
      for await (const event of fixture.client.streamConversation(projectId, "router", {
        signal: ac1.signal,
      })) {
        if (event.type === "snapshot" || event.type === "patch") {
          if (event.eventId !== undefined) savedEventId = event.eventId;
          if (JSON.stringify(event.view.entries).includes("Alpha response complete.")) {
            ac1.abort();
          }
        }
      }
    })();

    const send1 = await fixture.runCli(["send", projectId, "First turn", "--json"]);
    assert.equal(send1.code, 0, send1.stderr);
    await firstStreamLoop;

    assert.ok(savedEventId !== undefined, "expected eventId after turn 1");
    const lastSeenId = Number(savedEventId);
    assert.ok(Number.isSafeInteger(lastSeenId) && lastSeenId >= 1);

    // Run Turn 2 while disconnected.
    const send2 = await fixture.runCli(["send", projectId, "Second turn", "--json"]);
    assert.equal(send2.code, 0, send2.stderr);
    await waitFor(async () => {
      const page = await fixture.client.listEntries(projectId, "router", { order: "descending" });
      return page.entries.some((entry) =>
        JSON.stringify(entry).includes("Beta response complete."),
      );
    }, "turn 2 to commit while disconnected");

    // Reconnect via EeveeClient with lastEventId -> ONLY missed entries (> lastSeenId) arrive.
    const ac2 = new AbortController();
    let resumedSnapshotEntries: number[] = [];
    let resumedSnapshotBefore: number | undefined;
    let resumedText = "";
    let thirdTurnEventId: string | undefined;

    const resumedLoop = (async () => {
      for await (const event of fixture.client.streamConversation(projectId, "router", {
        lastEventId: savedEventId,
        signal: ac2.signal,
      })) {
        if (event.type === "snapshot") {
          resumedSnapshotEntries = event.view.entries.map((entry) => entry.id);
          resumedSnapshotBefore = event.view.before;
          resumedText = JSON.stringify(event.view.entries);
        } else if (event.type === "patch") {
          if (event.eventId !== undefined) thirdTurnEventId = event.eventId;
          if (JSON.stringify(event.view.entries).includes("Gamma response complete.")) {
            ac2.abort();
          }
        }
      }
    })();

    await waitFor(() => resumedSnapshotBefore !== undefined, "resumed snapshot");
    assert.equal(resumedSnapshotBefore, lastSeenId);
    assert.ok(resumedSnapshotEntries.length >= 2);
    assert.ok(resumedSnapshotEntries.every((id) => id > lastSeenId));
    assert.equal(resumedText.includes("Alpha response complete."), false);
    assert.equal(resumedText.includes("First turn"), false);
    assert.ok(resumedText.includes("Beta response complete."));

    // Run Turn 3 while reconnected stream is active.
    const send3 = await fixture.runCli(["send", projectId, "Third turn", "--json"]);
    assert.equal(send3.code, 0, send3.stderr);
    await resumedLoop;
    assert.ok(thirdTurnEventId !== undefined && Number(thirdTurnEventId) > lastSeenId);

    // Reconnect via CLI `eevee watch --last-event-id <savedEventId> --json` and verify zero duplicates.
    const cliWatchResumed = fixture.spawnCli([
      "watch",
      projectId,
      "router",
      "--last-event-id",
      savedEventId,
      "--json",
    ]);
    const ndjson = await cliWatchResumed.waitForStdout((out) => out.includes("\n"), 10_000);
    await cliWatchResumed.stop();

    const firstEvent = JSON.parse(ndjson.trim().split("\n")[0] ?? "{}") as {
      type?: string;
      view?: unknown;
      eventId?: string;
    };
    assert.equal(firstEvent.type, "snapshot");
    const parsedSnapshot = parseWithSchema(ConversationSnapshotEventSchema, {
      view: firstEvent.view,
    });
    assert.equal(parsedSnapshot.view.before, lastSeenId);
    assert.ok(parsedSnapshot.view.entries.every((entry) => entry.id > lastSeenId));
    const cliResumedDump = JSON.stringify(parsedSnapshot.view.entries);
    assert.equal(cliResumedDump.includes("Alpha response complete."), false);
    assert.equal(cliResumedDump.includes("First turn"), false);
    assert.ok(cliResumedDump.includes("Beta response complete."));
    assert.ok(cliResumedDump.includes("Gamma response complete."));

    // Paginate full history via client.listEntries
    const ascIds: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await fixture.client.listEntries(projectId, "router", {
        order: "ascending",
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      parseWithSchema(ListEntriesResponseSchema, page);
      ascIds.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const descIds: number[] = [];
    cursor = undefined;
    do {
      const page = await fixture.client.listEntries(projectId, "router", {
        order: "descending",
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      parseWithSchema(ListEntriesResponseSchema, page);
      descIds.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    assert.ok(ascIds.length >= 6);
    assert.deepEqual([...descIds].reverse(), ascIds);
    const fullPage = await fixture.client.listEntries(projectId, "router", {
      order: "ascending",
      limit: 500,
    });
    const fullDump = JSON.stringify(fullPage.entries);
    assert.ok(fullDump.includes("Alpha response complete."));
    assert.ok(fullDump.includes("Beta response complete."));
    assert.ok(fullDump.includes("Gamma response complete."));
  } finally {
    await fixture.cleanup();
  }
});
