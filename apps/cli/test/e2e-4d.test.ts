import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isProcessAlive,
  readAuthToken,
  readEngineState,
  readSupervisorState,
  stopDaemon,
  writeSupervisorState,
} from "@eevee/engine";
import { EeveeClient } from "@eevee/protocol";
import {
  CLI_ENTRY,
  type CliRunResult,
  createScriptedOpenAiServer,
  lastUserOrToolMessage,
  type RecordedOpenAiRequest,
  type ScriptedOpenAiServer,
  type ScriptedOpenAiTurn,
  stopChildProcess,
  waitFor,
  waitForChildExit,
} from "./e2e-harness.ts";

type DaemonFixture = {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly workspaceDir: string;
  readonly mockOpenAi: ScriptedOpenAiServer;
  runCli(args: readonly string[]): Promise<CliRunResult>;
  client(): Promise<EeveeClient>;
  cleanup(): Promise<void>;
};

async function createDaemonFixture(
  resolveTurn: (
    request: RecordedOpenAiRequest,
    index: number,
  ) => ScriptedOpenAiTurn | Promise<ScriptedOpenAiTurn>,
): Promise<DaemonFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "eevee-daemon-e2e-"));
  const homeDir = join(rootDir, "home");
  const workspaceDir = join(rootDir, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const mockOpenAi = await createScriptedOpenAiServer(resolveTurn);
  await writeFile(
    join(homeDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: mockOpenAi.baseUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "test-model", reasoning: false }],
        },
      },
    }),
    "utf8",
  );

  const runCli = async (args: readonly string[]): Promise<CliRunResult> => {
    const child = spawn(process.execPath, ["--conditions=eevee-source", CLI_ENTRY, ...args], {
      cwd: workspaceDir,
      env: { ...process.env, EEVEE_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    let result: Awaited<ReturnType<typeof waitForChildExit>>;
    try {
      result = await waitForChildExit(child, 30_000);
    } catch (error) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 5_000).catch(() => undefined);
      throw error;
    }
    return { ...result, stdout: stdout.join(""), stderr: stderr.join("") };
  };

  const cleanup = async () => {
    const [supervisorBeforeStop, engineBeforeStop] = await Promise.all([
      readSupervisorState(join(homeDir, "supervisor.json")),
      readEngineState(join(homeDir, "engine.json")),
    ]);
    await stopDaemon({ dataDir: homeDir, timeoutMs: 3_000 }).catch(() => undefined);
    const [supervisorAfterStop, engineAfterStop] = await Promise.all([
      readSupervisorState(join(homeDir, "supervisor.json")),
      readEngineState(join(homeDir, "engine.json")),
    ]);
    const pids = new Set(
      [
        supervisorBeforeStop?.pid,
        engineBeforeStop?.pid,
        supervisorAfterStop?.pid,
        engineAfterStop?.pid,
      ].filter((pid): pid is number => pid !== undefined),
    );
    for (const pid of pids) {
      if (pid !== undefined && isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await mockOpenAi.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  return {
    rootDir,
    homeDir,
    workspaceDir,
    mockOpenAi,
    runCli,
    client: async () => {
      const state = await readEngineState(join(homeDir, "engine.json"));
      const token = await readAuthToken(join(homeDir, "engine.token"));
      assert.ok(state);
      assert.ok(token);
      return new EeveeClient({ baseUrl: state.url, token });
    },
    cleanup,
  };
}

function assertCliOk(result: CliRunResult): void {
  assert.equal(result.code, 0, `CLI failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function jsonOutput(result: CliRunResult): Record<string, unknown> {
  assertCliOk(result);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function createProject(fixture: DaemonFixture): Promise<string> {
  const result = await fixture.runCli([
    "project",
    "create",
    fixture.workspaceDir,
    "--title",
    "daemon-test",
    "--json",
    "--router-model",
    "mock/test-model",
    "--worker-model",
    "mock/test-model",
  ]);
  const output = jsonOutput(result);
  const project = output.project as { id?: unknown };
  assert.equal(typeof project.id, "string");
  return project.id as string;
}

async function routerText(fixture: DaemonFixture, projectId: string): Promise<string> {
  const client = await fixture.client();
  const entries = await client.listEntries(projectId, "router", { limit: 500 });
  return entries.entries.map((entry) => JSON.stringify(entry)).join("\n");
}

test("4D start/status, crash restart, idempotent start, and graceful stop clean up processes and state", async () => {
  const fixture = await createDaemonFixture(() => ({ textChunks: ["unused"] }));
  try {
    const [firstStart, secondStart] = await Promise.all([
      fixture.runCli(["start", "--port", "0", "--json"]),
      fixture.runCli(["start", "--port", "0", "--json"]),
    ]);
    const startedOutput = jsonOutput(firstStart);
    const duplicateOutput = jsonOutput(secondStart);
    const started = startedOutput.outcome === "started" ? startedOutput : duplicateOutput;
    const duplicate = startedOutput.outcome === "started" ? duplicateOutput : startedOutput;
    assert.equal(started.outcome, "started");
    assert.equal(duplicate.outcome, "already_running");
    assert.equal(duplicate.enginePid, started.enginePid);
    assert.equal(started.status, "running");
    const firstEnginePid = Number(started.enginePid);
    const supervisorPid = Number(started.supervisorPid);
    assert.ok(isProcessAlive(firstEnginePid));
    assert.ok(isProcessAlive(supervisorPid));

    const duplicateStatus = jsonOutput(await fixture.runCli(["start", "--port", "0", "--json"]));
    assert.equal(duplicateStatus.outcome, "already_running");
    assert.equal(duplicateStatus.enginePid, firstEnginePid);

    const running = jsonOutput(await fixture.runCli(["status", "--json"]));
    assert.equal(running.status, "running");
    assert.equal(running.enginePid, firstEnginePid);
    assert.equal(running.supervisorPid, supervisorPid);

    process.kill(firstEnginePid, "SIGKILL");
    await waitFor(async () => {
      const engine = await readEngineState(join(fixture.homeDir, "engine.json"));
      const supervisor = await readSupervisorState(join(fixture.homeDir, "supervisor.json"));
      if (engine === undefined || engine.pid === firstEnginePid) return false;
      if (supervisor?.restartCount !== 1 || supervisor.enginePid !== engine.pid) return false;
      try {
        const client = await fixture.client();
        return (await client.health()).pid === engine.pid;
      } catch {
        return false;
      }
    }, "supervisor to restart a healthy replacement Engine");

    const restarted = jsonOutput(await fixture.runCli(["status", "--json"]));
    assert.equal(restarted.status, "running");
    assert.equal(restarted.restartCount, 1);
    assert.notEqual(restarted.enginePid, firstEnginePid);
    const secondEnginePid = Number(restarted.enginePid);

    assertCliOk(await fixture.runCli(["stop"]));
    await waitFor(
      () => !isProcessAlive(supervisorPid) && !isProcessAlive(secondEnginePid),
      "supervisor and replacement Engine to exit",
    );
    assert.equal(await readEngineState(join(fixture.homeDir, "engine.json")), undefined);
    assert.equal(await readSupervisorState(join(fixture.homeDir, "supervisor.json")), undefined);
    assert.deepEqual(jsonOutput(await fixture.runCli(["status", "--json"])), {
      status: "stopped",
      restartCount: 0,
    });
    assert.equal(jsonOutput(await fixture.runCli(["stop", "--json"])).outcome, "already_stopped");
  } finally {
    await fixture.cleanup();
  }
});

test("4D start and stop are serialized while startup still owns the control lock", async () => {
  const fixture = await createDaemonFixture(() => ({ textChunks: ["unused"] }));
  try {
    const starting = fixture.runCli(["start", "--port", "0", "--json"]);
    await waitFor(async () => {
      try {
        await stat(join(fixture.homeDir, "start.lock"));
        return true;
      } catch {
        return false;
      }
    }, "start to acquire the daemon control lock");
    const stopping = fixture.runCli(["stop", "--json"]);
    const [started, stopped] = await Promise.all([starting, stopping]);
    assert.equal(jsonOutput(started).outcome, "started");
    assert.equal(jsonOutput(stopped).outcome, "stopped");
    assert.equal(jsonOutput(await fixture.runCli(["status", "--json"])).status, "stopped");
  } finally {
    await fixture.cleanup();
  }
});

test("4D start restores supervision after supervisor death and stop cleans the next orphan", async () => {
  const fixture = await createDaemonFixture(() => ({ textChunks: ["unused"] }));
  try {
    const started = jsonOutput(await fixture.runCli(["start", "--port", "0", "--json"]));
    const firstSupervisorPid = Number(started.supervisorPid);
    const firstEnginePid = Number(started.enginePid);
    process.kill(firstSupervisorPid, "SIGKILL");
    await waitFor(() => !isProcessAlive(firstSupervisorPid), "first supervisor to exit");
    assert.equal(isProcessAlive(firstEnginePid), true);

    const restored = jsonOutput(await fixture.runCli(["start", "--port", "0", "--json"]));
    assert.equal(restored.outcome, "started");
    assert.equal(restored.status, "running");
    assert.notEqual(restored.supervisorPid, firstSupervisorPid);
    assert.notEqual(restored.enginePid, firstEnginePid);
    await waitFor(() => !isProcessAlive(firstEnginePid), "orphaned Engine to stop");

    const secondSupervisorPid = Number(restored.supervisorPid);
    const secondEnginePid = Number(restored.enginePid);
    process.kill(secondSupervisorPid, "SIGKILL");
    await waitFor(() => !isProcessAlive(secondSupervisorPid), "second supervisor to exit");
    const stopped = jsonOutput(await fixture.runCli(["stop", "--json"]));
    assert.ok(stopped.outcome === "stopped" || stopped.outcome === "already_stopped");
    await waitFor(() => !isProcessAlive(secondEnginePid), "second orphaned Engine to exit");
    assert.equal(await readSupervisorState(join(fixture.homeDir, "supervisor.json")), undefined);
    assert.equal(await readEngineState(join(fixture.homeDir, "engine.json")), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("4D stop closes an authenticated orphan Engine and removes dead supervisor state", async () => {
  const fixture = await createDaemonFixture(() => ({ textChunks: ["unused"] }));
  const engineChild = spawn(
    process.execPath,
    ["--conditions=eevee-source", CLI_ENTRY, "start", "--foreground", "--port", "0"],
    {
      cwd: fixture.workspaceDir,
      env: { ...process.env, EEVEE_HOME: fixture.homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await waitFor(async () => {
      try {
        return (await (await fixture.client()).health()).pid === engineChild.pid;
      } catch {
        return false;
      }
    }, "standalone foreground Engine to become healthy");
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await waitForChildExit(dead);
    assert.ok(dead.pid !== undefined);
    const engine = await readEngineState(join(fixture.homeDir, "engine.json"));
    assert.ok(engine);
    await writeSupervisorState(join(fixture.homeDir, "supervisor.json"), {
      pid: dead.pid,
      enginePid: engine.pid,
      port: engine.port,
      startedAt: 1,
      restartCount: 3,
      stopping: false,
    });

    assert.equal(jsonOutput(await fixture.runCli(["stop", "--json"])).outcome, "stopped");
    await waitForChildExit(engineChild);
    assert.equal(await readSupervisorState(join(fixture.homeDir, "supervisor.json")), undefined);
    assert.equal(await readEngineState(join(fixture.homeDir, "engine.json")), undefined);
  } finally {
    await stopChildProcess(engineChild).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("4D graceful stop and restart recovers an unfinished Router run without duplicate input", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let requestCount = 0;
  const fixture = await createDaemonFixture(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      await firstGate;
      return { textChunks: ["too late"] };
    }
    return { textChunks: ["recovered after graceful restart"] };
  });
  try {
    assertCliOk(await fixture.runCli(["start", "--port", "0"]));
    const projectId = await createProject(fixture);
    assertCliOk(await fixture.runCli(["send", projectId, "resume this run"]));
    await waitFor(() => requestCount >= 1, "first Router model request");

    assertCliOk(await fixture.runCli(["stop"]));
    releaseFirst?.();
    assert.equal(await readEngineState(join(fixture.homeDir, "engine.json")), undefined);

    assertCliOk(await fixture.runCli(["start", "--port", "0"]));
    await waitFor(
      async () =>
        (await routerText(fixture, projectId)).includes("recovered after graceful restart"),
      "recovered Router reply",
    );
    const text = await routerText(fixture, projectId);
    assert.equal(text.split("resume this run").length - 1, 1);
    assert.equal(text.includes("too late"), false);
    assert.ok(requestCount >= 2);
  } finally {
    releaseFirst?.();
    await fixture.cleanup();
  }
});

test("4D Engine crash during a Worker run resumes and hands off exactly once", async () => {
  let releaseFirstWorker: (() => void) | undefined;
  const firstWorkerGate = new Promise<void>((resolve) => {
    releaseFirstWorker = resolve;
  });
  let workerAttempts = 0;
  const fixture = await createDaemonFixture(async (request) => {
    const last = lastUserOrToolMessage(request);
    if (last.role === "user" && last.text.includes("do durable work")) {
      workerAttempts += 1;
      if (workerAttempts === 1) {
        await firstWorkerGate;
        return { textChunks: ["late first attempt"] };
      }
      return { textChunks: ["durable result delivered once"] };
    }
    if (last.role === "user" && last.text.includes("durable result delivered once")) {
      return { textChunks: ["Router observed one durable result"] };
    }
    if (last.role === "user" && last.text.includes("start crash test")) {
      return {
        toolCalls: [
          {
            name: "spawn_worker",
            arguments: {
              name: "durable-worker",
              prompt: "do durable work",
              ticketTitle: "Durable work",
            },
          },
        ],
      };
    }
    if (last.role === "tool" && last.toolName === "spawn_worker") {
      return { textChunks: ["Delegated durable work."] };
    }
    throw new Error(`Unexpected request: ${JSON.stringify(last)}`);
  });
  try {
    assertCliOk(await fixture.runCli(["start", "--port", "0"]));
    const projectId = await createProject(fixture);
    assertCliOk(await fixture.runCli(["send", projectId, "start crash test"]));
    await waitFor(() => workerAttempts >= 1, "first Worker model request");
    const firstEngine = await readEngineState(join(fixture.homeDir, "engine.json"));
    const supervisor = await readSupervisorState(join(fixture.homeDir, "supervisor.json"));
    assert.ok(firstEngine);
    assert.ok(supervisor);
    process.kill(firstEngine.pid, "SIGKILL");

    await waitFor(
      async () => {
        try {
          return (await routerText(fixture, projectId)).includes(
            "Router observed one durable result",
          );
        } catch {
          return false;
        }
      },
      "Worker recovery and final Router reply",
      25_000,
    );
    releaseFirstWorker?.();
    const text = await routerText(fixture, projectId);
    assert.equal(text.split("durable result delivered once").length - 1, 1);
    assert.equal(text.includes("late first attempt"), false);
    assert.equal(workerAttempts, 2);

    const board = await (await fixture.client()).getBoard(projectId);
    assert.equal(board.workers.length, 1);
    assert.equal(board.tickets.find((ticket) => ticket.workerId === "w1")?.status, "open");
    const currentSupervisor = await readSupervisorState(join(fixture.homeDir, "supervisor.json"));
    assert.equal(currentSupervisor?.pid, supervisor.pid);
    assert.equal(currentSupervisor?.restartCount, 1);
  } finally {
    releaseFirstWorker?.();
    await fixture.cleanup();
  }
});
