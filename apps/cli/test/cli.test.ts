import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EeveeClient } from "@eevee/protocol";
import type { Command } from "commander";
import { parseNonEmpty, parseToolOverridesFlag, parseToolsSettingsFlags } from "../src/args.ts";
import { runEngineCommand, withSignalAbort } from "../src/command-helpers.ts";
import { mergeMcpAddConfig } from "../src/commands/mcp.ts";
import { mergeProjectModels, mergeToolsSettings } from "../src/commands/project.ts";
import {
  aggregateBoardTasks,
  ConversationWatchRenderer,
  formatBoard,
  formatMcpLogs,
  formatMcpState,
  formatMcpStatus,
  formatModelProfiles,
  formatModels,
  formatProbeResult,
  formatProjectMcpState,
  formatProjectUsage,
  formatProviderCatalog,
  formatProviderDetail,
  formatProviders,
  formatQuestionAnswered,
  formatRefreshModels,
  formatReloadModels,
  formatSettings,
  formatSkillsList,
  formatSmokeTestResult,
  formatTaskList,
  formatTaskOutput,
  parseModelFlag,
  TaskWatchRenderer,
} from "../src/format.ts";
import { createProgram } from "../src/index.ts";
import { runMcpOAuthLogin, runProviderLogin } from "../src/login-ui.ts";

test("CLI program registers core metadata and all 4A + 4B subcommands and options", () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  assert.equal(program.name(), "eevee");
  const commands = program.commands.map((command) => command.name());
  for (const expected of [
    "info",
    "start",
    "stop",
    "status",
    "project",
    "send",
    "board",
    "watch",
    "answer",
    "interrupt",
    "retry",
    "task",
  ]) {
    assert.ok(commands.includes(expected), `missing command ${expected}`);
  }

  const projectCmd = program.commands.find((command) => command.name() === "project");
  assert.ok(projectCmd);
  const projectSubcommands = projectCmd.commands.map((command) => command.name());
  assert.ok(projectSubcommands.includes("create"));
  assert.ok(projectSubcommands.includes("list"));

  const sendCmd = program.commands.find((command) => command.name() === "send");
  assert.ok(sendCmd);
  assert.ok(sendCmd.options.some((opt) => opt.long === "--worker"));
  assert.ok(sendCmd.options.some((opt) => opt.long === "--when-busy"));

  const watchCmd = program.commands.find((command) => command.name() === "watch");
  assert.ok(watchCmd);
  assert.ok(watchCmd.options.some((opt) => opt.long === "--from"));
  assert.ok(watchCmd.options.some((opt) => opt.long === "--last-event-id"));
  assert.equal(watchCmd.registeredArguments.length, 2);

  const answerCmd = program.commands.find((command) => command.name() === "answer");
  assert.ok(answerCmd);
  assert.equal(answerCmd.registeredArguments.length, 3);

  const interruptCmd = program.commands.find((command) => command.name() === "interrupt");
  assert.ok(interruptCmd);
  assert.equal(interruptCmd.registeredArguments.length, 2);

  const retryCmd = program.commands.find((command) => command.name() === "retry");
  assert.ok(retryCmd);
  assert.equal(retryCmd.registeredArguments.length, 2);

  const taskCmd = program.commands.find((command) => command.name() === "task");
  assert.ok(taskCmd);
  const taskSubcommands = taskCmd.commands.map((command) => command.name());
  assert.ok(taskSubcommands.includes("list"));
  assert.ok(taskSubcommands.includes("read"));
  assert.ok(taskSubcommands.includes("watch"));
  assert.ok(taskSubcommands.includes("kill"));

  const taskListCmd = taskCmd.commands.find((command) => command.name() === "list");
  assert.ok(taskListCmd);
  assert.equal(taskListCmd.registeredArguments.length, 2);
  assert.ok(taskListCmd.options.some((opt) => opt.long === "--status"));
  assert.ok(taskListCmd.options.some((opt) => opt.long === "--limit"));
  assert.ok(taskListCmd.options.some((opt) => opt.long === "--json"));

  const taskReadCmd = taskCmd.commands.find((command) => command.name() === "read");
  assert.ok(taskReadCmd);
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--mode"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--bytes"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--since-bytes"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--end-byte"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--filter"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--context"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--json"));

  const taskWatchCmd = taskCmd.commands.find((command) => command.name() === "watch");
  assert.ok(taskWatchCmd);
  assert.ok(taskWatchCmd.options.some((opt) => opt.long === "--mode"));
  assert.ok(taskWatchCmd.options.some((opt) => opt.long === "--bytes"));
  assert.ok(taskWatchCmd.options.some((opt) => opt.long === "--since-bytes"));
  assert.ok(taskWatchCmd.options.some((opt) => opt.long === "--filter"));
  assert.ok(taskWatchCmd.options.some((opt) => opt.long === "--context"));
  assert.ok(taskWatchCmd.options.some((opt) => opt.long === "--json"));

  const taskKillCmd = taskCmd.commands.find((command) => command.name() === "kill");
  assert.ok(taskKillCmd);
  assert.ok(taskKillCmd.options.some((opt) => opt.long === "--json"));
});

test("CLI validates 4B flags/arguments and formats 4B outputs cleanly", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  program.exitOverride();

  await assert.rejects(
    program.parseAsync(["node", "eevee", "send", "demo", "hi", "--worker", "bad-worker"]),
    /Invalid --worker/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "watch", "demo", "bad-ref"]),
    /Invalid ref/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "answer", "demo", "q0", "yes"]),
    /Invalid questionId/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "interrupt", "demo", "bad-ref"]),
    /Invalid ref/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "retry", "demo", "bad-ref"]),
    /Invalid ref/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--mode",
      "middle",
    ]),
    /Invalid --mode/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--since-bytes",
      "-1",
    ]),
    /Invalid --since-bytes/,
  );

  assert.equal(
    formatQuestionAnswered({
      question: {
        id: "q1",
        items: [{ question: "Port?" }],
        answers: ["8080"],
        askedAt: 1,
        answeredAt: 2,
      },
    }),
    "Answered question q1 (1 answer)",
  );

  const formattedTask = formatTaskOutput("w1", {
    task: {
      id: "task-1",
      command: "node -e 'console.log(1)'",
      status: "running",
      startedAt: 1,
    },
    output: {
      text: "line1\nline2\n",
      totalBytes: 12,
      truncated: false,
      fromByte: 0,
      endByte: 12,
    },
  });
  assert.ok(formattedTask.includes("Worker w1 task task-1 [running]"));
  assert.ok(formattedTask.includes("Bytes 0..12 of 12"));
  assert.ok(formattedTask.includes("line1\nline2"));
});

test("eevee info prints resolved layout including tokenFile and stateFile", async () => {
  const home = join("/tmp", "eevee-cli-info-test");
  const program = createProgram({ EEVEE_HOME: home });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "eevee", "info"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
  assert.equal(parsed.tokenFile, join(parsed.home as string, "engine.token"));
  assert.equal(parsed.stateFile, join(parsed.home as string, "engine.json"));
});

test("eevee status reports stopped without a runtime state", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-stopped-test" });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "eevee", "status", "--json"]);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(JSON.parse(logs[0] ?? "{}"), { status: "stopped", restartCount: 0 });
});

test("parseModelFlag and formatBoard handle valid and edge-case inputs", () => {
  assert.deepEqual(parseModelFlag("openrouter/anthropic/claude-3.7", "--router-model"), {
    provider: "openrouter",
    modelId: "anthropic/claude-3.7",
  });
  assert.throws(() => parseModelFlag("noslash", "--router-model"), /provider/);
  assert.throws(() => parseModelFlag("/model", "--router-model"), /provider/);
  assert.throws(() => parseModelFlag("provider/", "--router-model"), /provider/);

  const formatted = formatBoard({
    workers: [
      {
        id: "w1",
        name: "builder",
        cwd: "/ws",
        conversationId: 2,
        activeTicketId: "t1",
        createdAt: 1,
        status: "running",
        activeTaskCount: 1,
        tasks: [],
      },
    ],
    tickets: [{ id: "t1", workerId: "w1", title: "Build", status: "open", createdAt: 1 }],
    questions: [{ id: "q1", items: [{ question: "Target port?" }], askedAt: 2 }],
  });
  assert.ok(
    formatted.includes('w1 "builder" [running] — ticket t1 (Build), 1 running background task(s)'),
  );
  assert.ok(formatted.includes("q1: Target port?"));
});

test("parseToolOverridesFlag parses Pi-style toggles and boolean assignments", () => {
  assert.equal(parseToolOverridesFlag(undefined, "--router-tools"), undefined);
  assert.equal(parseToolOverridesFlag([], "--router-tools"), undefined);
  assert.deepEqual(parseToolOverridesFlag("+powershell,-bash,+grep", "--worker-tools"), {
    powershell: true,
    bash: false,
    grep: true,
  });
  assert.deepEqual(
    parseToolOverridesFlag(
      ["+powershell", "-bash", "grep=on", "read=off", "write=1", "edit=0"],
      "--worker-tools",
    ),
    {
      powershell: true,
      bash: false,
      grep: true,
      read: false,
      write: true,
      edit: false,
    },
  );
  assert.deepEqual(parseToolOverridesFlag("read=true,ls=false,find=on", "--router-tools"), {
    read: true,
    ls: false,
    find: true,
  });
  assert.deepEqual(parseToolOverridesFlag(["+grep", "-grep,+ls"], "--router-tools"), {
    grep: false,
    ls: true,
  });
});

test("parseToolOverridesFlag rejects empty names and malformed tokens clearly", () => {
  for (const token of ["", "grep", "+", "-", "=on", "grep=", "grep=yes", "+grep=on"]) {
    assert.throws(
      () => parseToolOverridesFlag(token, "--router-tools"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("--router-tools"), error.message);
        assert.ok(error.message.includes(`"${token}"`), error.message);
        return true;
      },
    );
  }
  assert.throws(() => parseToolOverridesFlag("+", "--worker-tools"), /tool name must not be empty/);
  assert.throws(
    () => parseToolOverridesFlag("+ls,,+grep", "--router-tools"),
    /Invalid --router-tools token ""/,
  );
});

test("parseToolsSettingsFlags combines tool overrides and codemode settings", () => {
  assert.equal(parseToolsSettingsFlags({}), undefined);
  assert.deepEqual(
    parseToolsSettingsFlags({
      routerTools: "+grep,-ls",
      workerTools: ["-bash", "+powershell,+grep"],
      codemodeMode: "only",
      codemodeInlineBudget: "0",
    }),
    {
      router: { grep: true, ls: false },
      worker: { bash: false, powershell: true, grep: true },
      codemode: { mode: "only", inlineBudget: 0 },
    },
  );
  assert.deepEqual(parseToolsSettingsFlags({ routerTools: "read=on" }), {
    router: { read: true },
  });
  assert.deepEqual(parseToolsSettingsFlags({ workerTools: "bash=off" }), {
    worker: { bash: false },
  });
  assert.deepEqual(parseToolsSettingsFlags({ codemodeMode: "on" }), {
    codemode: { mode: "on" },
  });
  assert.deepEqual(parseToolsSettingsFlags({ codemodeInlineBudget: "1200" }), {
    codemode: { inlineBudget: 1200 },
  });

  assert.throws(
    () => parseToolsSettingsFlags({ codemodeMode: "sometimes" }),
    /Invalid --codemode-mode/,
  );
  assert.throws(
    () => parseToolsSettingsFlags({ codemodeInlineBudget: "-1" }),
    /Invalid --codemode-inline-budget "-1": expected non-negative integer/,
  );
  assert.throws(
    () => parseToolsSettingsFlags({ workerTools: "bash=maybe" }),
    /Invalid --worker-tools token "bash=maybe"/,
  );
});

test("ConversationWatchRenderer streams live deltas without duplicating committed text", () => {
  const output: string[] = [];
  const renderer = new ConversationWatchRenderer((chunk) => output.push(chunk));

  renderer.onSnapshot({
    conversation: { id: 1 },
    entries: [
      { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
    ],
    docs: { "pi.live": {} },
  });

  renderer.onPatch({
    conversation: { id: 1 },
    entries: [
      { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
    ],
    docs: {
      "pi.live": {
        generation: {
          attempt: 1,
          message: { role: "assistant", content: [{ type: "text", text: "Hello " }] },
        },
      },
    },
  });

  renderer.onPatch({
    conversation: { id: 1 },
    entries: [
      { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
    ],
    docs: {
      "pi.live": {
        generation: {
          attempt: 1,
          message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
        },
      },
    },
  });

  renderer.onPatch({
    conversation: { id: 1 },
    entries: [
      { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
      {
        id: 2,
        conversationId: 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello world!" }],
          },
        ],
      },
    ],
    docs: { "pi.live": {} },
  });

  renderer.onEnd();

  const text = output.join("");
  assert.equal(text, "[user] hi\n[assistant] Hello world!\n");
});

test("CLI program registers all 4C management commands, subcommands, and options", () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  const commands = program.commands.map((command) => command.name());
  for (const expected of ["auth", "models", "mcp", "config", "project"]) {
    assert.ok(commands.includes(expected), `missing command ${expected}`);
  }

  const authCmd = program.commands.find((c) => c.name() === "auth");
  assert.ok(authCmd);
  assert.deepEqual(authCmd.commands.map((c) => c.name()).sort(), ["login", "logout", "status"]);
  const authLogin = authCmd.commands.find((c) => c.name() === "login");
  assert.ok(authLogin?.options.some((o) => o.long === "--api-key"));
  assert.ok(authLogin?.options.some((o) => o.long === "--oauth"));

  const modelsCmd = program.commands.find((c) => c.name() === "models");
  assert.ok(modelsCmd);
  assert.deepEqual(modelsCmd.commands.map((c) => c.name()).sort(), [
    "list",
    "profiles",
    "refresh",
    "reload",
  ]);
  const profilesCmd = modelsCmd.commands.find((c) => c.name() === "profiles");
  assert.deepEqual(profilesCmd?.commands.map((c) => c.name()).sort(), ["get", "set"]);
  const modelsList = modelsCmd.commands.find((c) => c.name() === "list");
  assert.ok(modelsList?.options.some((o) => o.long === "--provider"));
  assert.ok(modelsList?.options.some((o) => o.long === "--available"));
  const modelsReload = modelsCmd.commands.find((c) => c.name() === "reload");
  assert.ok(modelsReload?.options.some((o) => o.long === "--json"));

  const mcpCmd = program.commands.find((c) => c.name() === "mcp");
  assert.ok(mcpCmd);
  assert.deepEqual(mcpCmd.commands.map((c) => c.name()).sort(), [
    "add",
    "list",
    "login",
    "logout",
    "logs",
    "reconnect",
    "remove",
    "set",
    "status",
  ]);
  const mcpAdd = mcpCmd.commands.find((c) => c.name() === "add");
  assert.ok(mcpAdd?.options.some((o) => o.long === "--command"));
  assert.ok(mcpAdd?.options.some((o) => o.long === "--args"));
  assert.ok(mcpAdd?.options.some((o) => o.long === "--url"));
  assert.ok(mcpAdd?.options.some((o) => o.long === "--exposure"));

  const configCmd = program.commands.find((c) => c.name() === "config");
  assert.ok(configCmd);
  assert.deepEqual(configCmd.commands.map((c) => c.name()).sort(), [
    "export",
    "get",
    "import",
    "set",
  ]);
  const configSet = configCmd.commands.find((c) => c.name() === "set");
  for (const flag of [
    "--max-active-workers",
    "--background-after-ms",
    "--router-context-tokens",
    "--idle-hibernate-ms",
    "--router-model",
    "--worker-model",
    "--dreamer-model",
    "--router-tools",
    "--worker-tools",
    "--codemode-mode",
    "--codemode-inline-budget",
  ]) {
    assert.ok(
      configSet?.options.some((o) => o.long === flag),
      `missing config set flag ${flag}`,
    );
  }

  const projectCmd = program.commands.find((c) => c.name() === "project");
  assert.ok(projectCmd);
  assert.deepEqual(projectCmd.commands.map((c) => c.name()).sort(), [
    "create",
    "list",
    "memory",
    "remove",
    "update",
    "usage",
  ]);
  const projectUpdate = projectCmd.commands.find((c) => c.name() === "update");
  for (const flag of [
    "--router-tools",
    "--worker-tools",
    "--codemode-mode",
    "--codemode-inline-budget",
    "--clear-tools",
  ]) {
    assert.ok(
      projectUpdate?.options.some((o) => o.long === flag),
      `missing project update flag ${flag}`,
    );
  }
  const projectMemory = projectCmd.commands.find((c) => c.name() === "memory");
  assert.deepEqual(projectMemory?.commands.map((c) => c.name()).sort(), ["get", "set"]);
});

test("CLI 4C formatters render readable output and validate incompatible flags", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  program.exitOverride();

  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "auth",
      "login",
      "anthropic",
      "--api-key",
      "k",
      "--oauth",
    ]),
    /Cannot combine --api-key and --oauth/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "add", "docs"]),
    /Specify exactly one of --command or --url/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "mcp",
      "add",
      "docs",
      "--command",
      "x",
      "--exposure",
      "bad",
    ]),
    /Invalid --exposure/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "config", "set"]),
    /Specify at least one setting/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "project", "update", "demo"]),
    /Specify at least one field/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "project", "memory", "set", "demo", "hi", "--clear"]),
    /Specify only one/,
  );

  assert.ok(
    formatProviders({
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          authMethods: { apiKey: true, apiKeyLogin: true, oauth: true },
          configured: true,
          authType: "oauth",
          authSource: "OAuth",
          modelCount: 5,
        },
      ],
    }).includes("anthropic\tAnthropic\t-\tconfigured (oauth: OAuth)"),
  );
  assert.ok(
    formatModels({
      models: [
        {
          provider: "anthropic",
          id: "claude",
          name: "Claude",
          api: "anthropic-messages",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 8_192,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          available: true,
        },
      ],
    }).includes("anthropic/claude"),
  );
  assert.equal(formatRefreshModels({ refreshed: true, errors: {} }), "Refreshed models.");
  assert.ok(
    formatModelProfiles({
      profiles: [
        {
          id: "fast",
          model: { provider: "mock", modelId: "m1" },
          description: "Quick tasks",
        },
      ],
      notes: "Use fast by default.",
    }).includes("fast\tmock/m1\tQuick tasks"),
  );
  assert.ok(
    formatMcpState({
      servers: { docs: { command: "docs" } },
      status: [{ name: "docs", status: "connected", enabled: true, toolCount: 2 }],
    }).includes("docs\tconnected\ttools=2"),
  );
  assert.ok(formatSettings({ maxActiveWorkers: 4 }).includes('"maxActiveWorkers": 4'));
  assert.ok(
    formatProjectUsage({
      projectId: "demo",
      usage: {
        models: {
          "mock/m1": {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
          },
        },
        tools: {},
      },
    }).includes("mock/m1: totalTokens=15"),
  );
});

test("project update rejects every tool setting combined with --clear-tools", async () => {
  const toolFlags = [
    ["--router-tools", "+grep"],
    ["--worker-tools", "-bash"],
    ["--codemode-mode", "on"],
    ["--codemode-inline-budget", "100"],
  ];
  for (const flags of toolFlags) {
    const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
    program.exitOverride();
    await assert.rejects(
      program.parseAsync(["node", "eevee", "project", "update", "demo", "--clear-tools", ...flags]),
      /Cannot combine tool override flags with --clear-tools/,
    );
  }
});

test("CLI validates task list, read, and watch flags cleanly", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  program.exitOverride();

  await assert.rejects(
    program.parseAsync(["node", "eevee", "task", "list", "demo", "bad-worker"]),
    /Invalid worker/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "task", "list", "demo", "--status", "paused"]),
    /Invalid --status/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "task", "list", "demo", "--limit", "0"]),
    /Invalid --limit/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "task", "list", "demo", "--limit", "-3"]),
    /Invalid --limit/,
  );

  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--end-byte",
      "-1",
    ]),
    /Invalid --end-byte/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "task", "read", "demo", "w1", "task-1", "--filter", ""]),
    /Invalid --filter/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--filter",
      "/[unclosed/",
    ]),
    /Invalid filter regular expression/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "task", "read", "demo", "w1", "task-1", "--context", "1"]),
    /--context requires --filter/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--filter",
      "err",
      "--context",
      "-1",
    ]),
    /Invalid --context/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--filter",
      "err",
      "--context",
      "6",
    ]),
    /Invalid --context/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "read",
      "demo",
      "w1",
      "task-1",
      "--filter",
      "err",
      "--context",
      "1.5",
    ]),
    /Invalid --context/,
  );

  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "watch",
      "demo",
      "w1",
      "task-1",
      "--mode",
      "middle",
    ]),
    /Invalid --mode/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "watch",
      "demo",
      "w1",
      "task-1",
      "--since-bytes",
      "-5",
    ]),
    /Invalid --since-bytes/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "watch",
      "demo",
      "w1",
      "task-1",
      "--context",
      "2",
    ]),
    /--context requires --filter/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "watch",
      "demo",
      "w1",
      "task-1",
      "--filter",
      "err",
      "--context",
      "6",
    ]),
    /Invalid --context/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "task",
      "watch",
      "demo",
      "w1",
      "task-1",
      "--filter",
      "/[bad/",
    ]),
    /Invalid filter regular expression/,
  );
});

test("formatTaskOutput, formatTaskList, and aggregateBoardTasks format task metadata and filters", () => {
  const richOutput = formatTaskOutput("w2", {
    task: {
      id: "task-3",
      command: "npm test",
      status: "cancelled",
      cancelReason: "user",
      logTruncated: true,
      logError: "disk full",
      startedAt: 100,
      endedAt: 200,
    },
    output: {
      text: "5: ERR: boom\n",
      totalBytes: 4096,
      truncated: true,
      fromByte: 0,
      endByte: 4096,
      matchedLines: 1,
      totalMatchedLines: 4,
      scanTruncated: true,
    },
  });
  assert.ok(richOutput.includes("Worker w2 task task-3 [cancelled] (reason user) — npm test"));
  assert.ok(
    richOutput.includes(
      "Bytes 0..4096 of 4096 (truncated) | Matches: 1 of 4 line(s), scan truncated",
    ),
  );
  assert.ok(
    richOutput.includes(
      "Warnings: log truncated (output exceeded log size limit); log error: disk full",
    ),
  );
  assert.ok(richOutput.includes("5: ERR: boom"));

  assert.equal(formatTaskList([]), "No tasks.");

  const board = {
    workers: [
      {
        id: "w1",
        name: "alpha",
        cwd: "/ws",
        conversationId: 2,
        createdAt: 1,
        status: "running" as const,
        activeTaskCount: 1,
        tasks: [
          {
            id: "task-1",
            command: "echo done",
            status: "completed" as const,
            exitCode: 0,
            startedAt: 100,
            endedAt: 150,
          },
          { id: "task-2", command: "npm run dev", status: "running" as const, startedAt: 300 },
        ],
      },
      {
        id: "w2",
        name: "beta",
        cwd: "/ws",
        conversationId: 3,
        createdAt: 2,
        status: "idle" as const,
        activeTaskCount: 1,
        tasks: [
          { id: "task-1", command: "watch logs", status: "queued" as const, startedAt: 200 },
          {
            id: "task-2",
            command: "sleep 60",
            status: "cancelled" as const,
            cancelReason: "user" as const,
            startedAt: 400,
            endedAt: 420,
          },
        ],
      },
    ],
    tickets: [],
    questions: [],
  };

  const allAggregated = aggregateBoardTasks(board);
  assert.deepEqual(
    allAggregated.map((t) => `${t.workerId}/${t.id}`),
    ["w2/task-1", "w1/task-2", "w1/task-1", "w2/task-2"],
  );
  assert.deepEqual(
    aggregateBoardTasks(board, { status: "active" }).map((t) => `${t.workerId}/${t.id}`),
    ["w2/task-1", "w1/task-2"],
  );
  assert.deepEqual(
    aggregateBoardTasks(board, { status: "finished", limit: 1 }).map(
      (t) => `${t.workerId}/${t.id}`,
    ),
    ["w2/task-2"],
  );
  assert.deepEqual(
    aggregateBoardTasks(board, { status: "all", limit: 3 }).map((t) => `${t.workerId}/${t.id}`),
    ["w2/task-1", "w1/task-2", "w2/task-2"],
  );
  assert.deepEqual(
    aggregateBoardTasks(board, { status: "all", limit: 1 }).map((t) => `${t.workerId}/${t.id}`),
    ["w1/task-2"],
  );

  const projectTable = formatTaskList(allAggregated, { showWorker: true });
  assert.ok(projectTable.includes("w2\ttask-1\tqueued\twatch logs"));
  assert.ok(projectTable.includes("w1\ttask-2\trunning\tnpm run dev"));
  assert.ok(projectTable.includes("w1\ttask-1\tcompleted (exit 0)\techo done"));
  assert.ok(projectTable.includes("w2\ttask-2\tcancelled (reason user)\tsleep 60"));

  const singleWorkerTable = formatTaskList(board.workers[0]?.tasks ?? [], { showWorker: false });
  assert.equal(
    singleWorkerTable,
    "task-1\tcompleted (exit 0)\techo done\ntask-2\trunning\tnpm run dev",
  );
});

test("TaskWatchRenderer streams raw and filtered chunks with context and status transitions", () => {
  const rawChunks: string[] = [];
  const raw = new TaskWatchRenderer((chunk) => rawChunks.push(chunk), { workerId: "w1" });
  raw.onSnapshot(
    { id: "task-1", command: "echo hi", status: "queued", startedAt: 1 },
    { text: "hello ", totalBytes: 6, truncated: false, fromByte: 0, endByte: 6 },
  );
  raw.onStatus({ id: "task-1", command: "echo hi", status: "running", startedAt: 1 });
  raw.onChunk("world");
  raw.onStatus({
    id: "task-1",
    command: "echo hi",
    status: "completed",
    exitCode: 0,
    logTruncated: true,
    startedAt: 1,
    endedAt: 2,
  });
  raw.onEnd({ type: "end", reason: "completed" });
  assert.equal(
    rawChunks.join(""),
    [
      "Worker w1 task task-1 [queued] — echo hi",
      "hello ",
      "[status] queued -> running",
      "world",
      "[status] running -> completed (exit 0)",
      "Warning: log truncated (output exceeded log size limit)",
      "[end] completed",
      "",
    ].join("\n"),
  );

  const filteredChunks: string[] = [];
  const filtered = new TaskWatchRenderer((chunk) => filteredChunks.push(chunk), {
    workerId: "w1",
    filter: "/err|warn/i",
    contextLines: 1,
  });
  filtered.onSnapshot(
    { id: "task-2", command: "run", status: "running", startedAt: 1 },
    { text: "a\nb\nERR", totalBytes: 7, truncated: false, fromByte: 0, endByte: 7 },
  );
  filtered.onChunk(": one\r\nc\nd\ne\nWARN: two");
  filtered.onStatus({
    id: "task-2",
    command: "run",
    status: "cancelled",
    cancelReason: "user",
    startedAt: 1,
    endedAt: 2,
  });
  filtered.onEnd({ type: "end", reason: "completed" });
  assert.equal(
    filteredChunks.join(""),
    [
      "Worker w1 task task-2 [running] — run",
      "2- b",
      "3: ERR: one",
      "4- c",
      "--",
      "6- e",
      "7: WARN: two",
      "[status] running -> cancelled (reason user)",
      "[end] completed",
      "",
    ].join("\n"),
  );

  const zeroContextChunks: string[] = [];
  const zeroContext = new TaskWatchRenderer((chunk) => zeroContextChunks.push(chunk), {
    workerId: "w1",
    filter: "hit",
    contextLines: 0,
  });
  zeroContext.onSnapshot(
    { id: "task-3", command: "run", status: "completed", exitCode: 0, startedAt: 1, endedAt: 2 },
    { text: "hit 1\nmiss\nhit 2\n", totalBytes: 16, truncated: false, fromByte: 0, endByte: 16 },
  );
  zeroContext.onEnd({ type: "end", reason: "terminal" });
  assert.equal(
    zeroContextChunks.join(""),
    [
      "Worker w1 task task-3 [completed] (exit 0) — run",
      "1: hit 1",
      "3: hit 2",
      "[end] terminal",
      "",
    ].join("\n"),
  );
});

test("CLI program registers provider management subcommands and options", () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  const providerCmd = program.commands.find((c) => c.name() === "provider");
  assert.ok(providerCmd);
  assert.deepEqual(providerCmd.commands.map((c) => c.name()).sort(), [
    "add",
    "list",
    "probe",
    "remove",
    "show",
    "test",
    "update",
  ]);

  const listCmd = providerCmd.commands.find((c) => c.name() === "list");
  assert.ok(listCmd);
  assert.ok(listCmd.options.some((o) => o.long === "--catalog"));
  assert.ok(listCmd.options.some((o) => o.long === "--json"));

  const showCmd = providerCmd.commands.find((c) => c.name() === "show");
  assert.ok(showCmd);
  assert.equal(showCmd.registeredArguments.length, 1);
  assert.ok(showCmd.options.some((o) => o.long === "--json"));

  const addCmd = providerCmd.commands.find((c) => c.name() === "add");
  assert.ok(addCmd);
  assert.equal(addCmd.registeredArguments.length, 1);
  for (const flag of [
    "--name",
    "--api",
    "--base-url",
    "--api-key",
    "--auth-header",
    "--header",
    "--probe-import",
    "--json",
  ]) {
    assert.ok(
      addCmd.options.some((o) => o.long === flag),
      `missing provider add flag ${flag}`,
    );
  }

  const updateCmd = providerCmd.commands.find((c) => c.name() === "update");
  assert.ok(updateCmd);
  assert.equal(updateCmd.registeredArguments.length, 1);
  for (const flag of [
    "--name",
    "--api",
    "--base-url",
    "--api-key",
    "--auth-header",
    "--no-auth-header",
    "--header",
    "--json",
  ]) {
    assert.ok(
      updateCmd.options.some((o) => o.long === flag),
      `missing provider update flag ${flag}`,
    );
  }

  const removeCmd = providerCmd.commands.find((c) => c.name() === "remove");
  assert.ok(removeCmd);
  assert.equal(removeCmd.registeredArguments.length, 1);
  assert.ok(removeCmd.options.some((o) => o.long === "--json"));

  const probeCmd = providerCmd.commands.find((c) => c.name() === "probe");
  assert.ok(probeCmd);
  assert.equal(probeCmd.registeredArguments.length, 1);
  for (const flag of ["--base-url", "--api", "--api-key", "--import", "--json"]) {
    assert.ok(
      probeCmd.options.some((o) => o.long === flag),
      `missing provider probe flag ${flag}`,
    );
  }

  const testCmd = providerCmd.commands.find((c) => c.name() === "test");
  assert.ok(testCmd);
  assert.equal(testCmd.registeredArguments.length, 2);
  for (const flag of ["--thinking", "--tools", "--timeout", "--json"]) {
    assert.ok(
      testCmd.options.some((o) => o.long === flag),
      `missing provider test flag ${flag}`,
    );
  }
});

test("CLI validates provider subcommand flags cleanly", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  program.exitOverride();

  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "add", "   "]),
    /Invalid providerId/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "add", "custom", "--header", "BADHEADER"]),
    /Invalid --header/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "update", "custom"]),
    /Specify at least one field to update/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "update", "custom", "--header", "=value"]),
    /Invalid --header/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "test", "custom", "   "]),
    /Invalid modelId/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "provider",
      "test",
      "custom",
      "m1",
      "--thinking",
      "ultra",
    ]),
    /Invalid --thinking/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "test", "custom", "m1", "--timeout", "999"]),
    /Invalid --timeout "999": expected integer 1000\.\.60000/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "provider", "test", "custom", "m1", "--timeout", "60001"]),
    /Invalid --timeout "60001": expected integer 1000\.\.60000/,
  );
});

test("CLI provider and reload formatters render catalog, detail, probe, smoke test, and diagnostics", () => {
  const providersOut = formatProviders({
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        kind: "builtin",
        hasConfigOverride: true,
        api: "openai-responses",
        authMethods: { apiKey: true, apiKeyLogin: false, oauth: true },
        configured: true,
        authType: "api_key",
        authSource: "$OPENAI_API_KEY",
        authPreview: "sk-...99",
        modelCount: 10,
        customModelCount: 1,
        overrideCount: 2,
      },
    ],
    diagnostics: [
      { path: "providers.broken.baseUrl", message: "must be a valid URL", line: 12, column: 7 },
    ],
  });
  assert.ok(
    providersOut.includes(
      "openai\tOpenAI\tbuiltin+override\tconfigured (api_key: $OPENAI_API_KEY)",
    ),
  );
  assert.ok(providersOut.includes("custom=1\toverrides=2\tauth=sk-...99"));
  assert.ok(providersOut.includes("models.json diagnostics:"));
  assert.ok(providersOut.includes("- providers.broken.baseUrl:12:7: must be a valid URL"));

  const catalogOut = formatProviderCatalog({
    supportedApis: ["openai-responses", "openai-completions", "anthropic-messages"],
    compatSchemas: {},
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apis: ["openai-responses"],
        modelCount: 12,
        configured: true,
        hasConfigOverride: true,
        authMethods: { apiKey: true, apiKeyLogin: false, oauth: false },
      },
    ],
  });
  assert.ok(
    catalogOut.includes("Supported APIs: openai-responses, openai-completions, anthropic-messages"),
  );
  assert.ok(
    catalogOut.includes(
      "openai\tOpenAI\tapis=[openai-responses]\turl=https://api.openai.com/v1\tmodels=12\tconfigured\toverride\tmethods=[api_key]",
    ),
  );
  assert.ok(
    formatProviderCatalog({
      supportedApis: ["openai-completions"],
      compatSchemas: {},
      providers: [],
    }).includes("No builtin providers."),
  );

  const thinkingRule = { enabled: true };
  const detailOut = formatProviderDetail({
    id: "vllm",
    name: "Local vLLM",
    kind: "custom",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8000/v1/v1",
    authMethods: { apiKey: true, apiKeyLogin: false, oauth: false },
    configured: true,
    authType: "api_key",
    authSource: "$VLLM_KEY",
    authPreview: "sk-...12",
    modelCount: 1,
    customModelCount: 1,
    connectionNote: {
      text: "Requests target http://127.0.0.1:8000/v1/v1/chat/completions",
      warning: true,
    },
    config: {
      authHeader: true,
      hasApiKey: true,
      apiKeyRef: "$VLLM_KEY",
      headers: { "X-Team": "core" },
    },
    models: [
      {
        provider: "vllm",
        id: "qwen-32b",
        name: "Qwen 32B",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8000/v1/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 32_768,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        available: true,
        isCustom: true,
        isBuiltin: false,
        hasOverride: false,
        supportedThinkingLevels: ["off", "low", "high"],
        thinkingLevels: {
          off: thinkingRule,
          minimal: { enabled: false },
          low: thinkingRule,
          medium: { enabled: false },
          high: thinkingRule,
          xhigh: { enabled: false },
          max: { enabled: false },
        },
      },
    ],
  });
  assert.ok(detailOut.includes("vllm\tLocal vLLM\tcustom\tconfigured (api_key: $VLLM_KEY)"));
  assert.ok(
    detailOut.includes(
      "Connection: Requests target http://127.0.0.1:8000/v1/v1/chat/completions (warning: possible doubled /v1 — check the base URL)",
    ),
  );
  assert.ok(
    detailOut.includes(
      "Config: authHeader=true apiKey=set apiKeyRef=$VLLM_KEY headers=[X-Team=core]",
    ),
  );
  assert.ok(
    detailOut.includes(
      "- qwen-32b\tQwen 32B\topenai-completions\treasoning=true\tctx=32768\tmax=4096\tavailable=true\tthinking=[off,low,high]\tinput=[text,image]\tcustom",
    ),
  );

  const probeOkOut = formatProbeResult({
    ok: true,
    catalogUrl: "http://127.0.0.1:8000/v1/v1/models",
    connectionNote: {
      text: "Probing http://127.0.0.1:8000/v1/v1/models",
      warning: true,
    },
    truncated: true,
    models: [
      { id: "existing-model", exists: true },
      {
        id: "new-model",
        name: "New Model",
        contextWindow: 64_000,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: true,
        exists: false,
      },
    ],
  });
  assert.ok(probeOkOut.includes("Probe succeeded: 2 model(s) discovered, 1 new, truncated"));
  assert.ok(probeOkOut.includes("Catalog URL: http://127.0.0.1:8000/v1/v1/models"));
  assert.ok(
    probeOkOut.includes(
      "Connection: Probing http://127.0.0.1:8000/v1/v1/models (warning: possible doubled /v1 — check the base URL)",
    ),
  );
  assert.ok(probeOkOut.includes("- existing-model\texists"));
  assert.ok(
    probeOkOut.includes(
      "- new-model\tNew Model\tctx=64000\tmax=8192\tinput=[text]\treasoning=true\tnew",
    ),
  );

  const probeErrOut = formatProbeResult({
    ok: false,
    catalogUrl: "http://127.0.0.1:8000/v1/models",
    truncated: false,
    models: [],
    error: "ECONNREFUSED",
  });
  assert.ok(probeErrOut.includes("Probe failed: ECONNREFUSED"));

  const smokeOkOut = formatSmokeTestResult({
    ok: true,
    ttftMs: 120,
    totalMs: 450,
    sawReasoning: true,
    sawToolCall: true,
    usage: { input: 10, output: 20, totalTokens: 30 },
    replyPreview: "pong",
  });
  assert.equal(
    smokeOkOut,
    [
      "Smoke test passed (total=450ms, ttft=120ms, reasoning=yes, toolCall=yes, tokens in=10 out=20 total=30)",
      "Reply: pong",
    ].join("\n"),
  );

  const smokeFailOut = formatSmokeTestResult({
    ok: false,
    totalMs: 1000,
    sawReasoning: false,
    sawToolCall: false,
    replyPreview: "",
    error: "401 Unauthorized",
  });
  assert.equal(
    smokeFailOut,
    ["Smoke test failed (total=1000ms, reasoning=no, toolCall=no)", "Error: 401 Unauthorized"].join(
      "\n",
    ),
  );

  const reloadOkOut = formatReloadModels({
    reloaded: true,
    providerCount: 15,
    modelCount: 120,
    diagnostics: [],
  });
  assert.equal(reloadOkOut, "Reloaded models.json: 15 provider(s), 120 model(s)");

  const reloadDiagOut = formatReloadModels({
    reloaded: true,
    providerCount: 14,
    modelCount: 110,
    diagnostics: [
      { path: "models.json", message: "invalid JSON", line: 4 },
      { path: "providers.custom.api", message: "unsupported api" },
    ],
  });
  assert.equal(
    reloadDiagOut,
    [
      "Reloaded models.json: 14 provider(s), 110 model(s)",
      "",
      "models.json diagnostics:",
      "- models.json:4: invalid JSON",
      "- providers.custom.api: unsupported api",
    ].join("\n"),
  );
});

test("CLI registers skills and upgraded MCP subcommands and options", () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });

  const skillsCmd = program.commands.find((c) => c.name() === "skills");
  assert.ok(skillsCmd);
  assert.deepEqual(skillsCmd.commands.map((c) => c.name()).sort(), [
    "clear-policy",
    "list",
    "set-policy",
  ]);

  const skillsList = skillsCmd.commands.find((c) => c.name() === "list");
  assert.ok(skillsList?.options.some((o) => o.long === "--project"));
  assert.ok(skillsList?.options.some((o) => o.long === "--json"));

  const skillsSetPolicy = skillsCmd.commands.find((c) => c.name() === "set-policy");
  assert.equal(skillsSetPolicy?.registeredArguments.length, 2);
  assert.ok(skillsSetPolicy?.options.some((o) => o.long === "--project"));
  assert.ok(skillsSetPolicy?.options.some((o) => o.long === "--json"));

  const skillsClearPolicy = skillsCmd.commands.find((c) => c.name() === "clear-policy");
  assert.ok(skillsClearPolicy?.options.some((o) => o.long === "--project"));
  assert.ok(skillsClearPolicy?.options.some((o) => o.long === "--json"));

  const mcpCmd = program.commands.find((c) => c.name() === "mcp");
  assert.ok(mcpCmd);
  const mcpSubcommands: readonly Command[] = mcpCmd.commands;

  for (const name of ["status", "list"]) {
    const cmd = mcpSubcommands.find((c) => c.name() === name);
    assert.ok(cmd, `missing mcp subcommand ${name}`);
    assert.ok(
      cmd.options.some((o) => o.long === "--project"),
      `missing --project on ${name}`,
    );
    assert.ok(
      cmd.options.some((o) => o.long === "--logs"),
      `missing --logs on ${name}`,
    );
    assert.ok(
      cmd.options.some((o) => o.long === "--json"),
      `missing --json on ${name}`,
    );
  }

  for (const name of ["set", "remove", "reconnect"]) {
    const cmd = mcpSubcommands.find((c) => c.name() === name);
    assert.ok(cmd, `missing mcp subcommand ${name}`);
    assert.ok(
      cmd.options.some((o) => o.long === "--project"),
      `missing --project on ${name}`,
    );
  }

  const mcpAdd = mcpCmd.commands.find((c) => c.name() === "add");
  assert.ok(mcpAdd);
  for (const flag of [
    "--project",
    "--router",
    "--no-router",
    "--worker",
    "--no-worker",
    "--disabled",
    "--no-disabled",
    "--replace",
  ]) {
    assert.ok(
      mcpAdd.options.some((o) => o.long === flag),
      `missing mcp add flag ${flag}`,
    );
  }
  const exposureOpt = mcpAdd.options.find((o) => o.long === "--exposure");
  assert.ok(exposureOpt?.description.includes("codemode"));

  const mcpLogs = mcpCmd.commands.find((c) => c.name() === "logs");
  assert.equal(mcpLogs?.registeredArguments.length, 1);
  assert.ok(mcpLogs?.options.some((o) => o.long === "--project"));
  assert.ok(mcpLogs?.options.some((o) => o.long === "--json"));

  const mcpLogin = mcpCmd.commands.find((c) => c.name() === "login");
  assert.equal(mcpLogin?.registeredArguments.length, 1);
  assert.ok(mcpLogin?.options.some((o) => o.long === "--project"));
  assert.ok(mcpLogin?.options.some((o) => o.long === "--json"));

  const mcpLogout = mcpCmd.commands.find((c) => c.name() === "logout");
  assert.equal(mcpLogout?.registeredArguments.length, 1);
  assert.ok(mcpLogout?.options.some((o) => o.long === "--project"));
  assert.ok(mcpLogout?.options.some((o) => o.long === "--json"));
});

test("CLI validates skills and upgraded MCP arguments and flags cleanly", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  program.exitOverride();

  await assert.rejects(
    program.parseAsync(["node", "eevee", "skills", "list", "--project", "../bad"]),
    /Invalid --project/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "skills", "set-policy", "   ", "model"]),
    /Invalid skillName/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "skills", "set-policy", "my-skill", "always"]),
    /Invalid mode "always": expected model, user, disabled, or reset/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "skills", "clear-policy", "--project", "bad/id"]),
    /Invalid --project/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "add", "docs", "--project", "demo"]),
    /Specify --command, --url, or at least one override flag/,
  );
  await assert.rejects(
    program.parseAsync([
      "node",
      "eevee",
      "mcp",
      "add",
      "docs",
      "--project",
      "demo",
      "--command",
      "npx",
      "--url",
      "https://example.com/mcp",
    ]),
    /Cannot combine --command and --url/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "logs", "   "]),
    /Invalid server name/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "login", "   "]),
    /Invalid server name/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "login", "docs", "--project", "../bad"]),
    /Invalid --project/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "logout", "   "]),
    /Invalid server name/,
  );
  await assert.rejects(
    program.parseAsync(["node", "eevee", "mcp", "logout", "docs", "--project", "../bad"]),
    /Invalid --project/,
  );
});

test("formatSkillsList, formatProjectMcpState, formatMcpLogs, and updated formatMcpStatus render complete details", () => {
  assert.equal(
    formatSkillsList({ skills: [], diagnostics: [], globalPolicy: {} }),
    "No skills discovered.",
  );

  const skillsText = formatSkillsList({
    skills: [
      {
        name: "shared-skill",
        description: "Shared\nskill",
        path: "/home/user/.agents/skills/shared-skill/SKILL.md",
        baseDir: "/home/user/.agents/skills/shared-skill",
        source: "global",
        disableModelInvocation: false,
        defaultMode: "model",
        effectiveMode: "disabled",
        globalOverride: "disabled",
      },
      {
        name: "ws-skill",
        description: "Workspace skill",
        path: "/ws/.agents/skills/ws-skill/SKILL.md",
        baseDir: "/ws/.agents/skills/ws-skill",
        source: "workspace",
        workspace: "/ws",
        disableModelInvocation: true,
        defaultMode: "user",
        effectiveMode: "model",
        globalOverride: "disabled",
        projectOverride: "model",
      },
    ],
    diagnostics: [
      {
        type: "collision",
        message: "Duplicate skill name",
        path: "/ws/.agents/skills/dup/SKILL.md",
        skillName: "shared-skill",
      },
      {
        type: "error",
        message: "Missing description",
        path: "/ws/.agents/skills/broken/SKILL.md",
      },
    ],
    globalPolicy: { "shared-skill": "disabled" },
    projectPolicy: { "ws-skill": "model" },
  });
  assert.ok(
    skillsText.includes(
      "shared-skill\tglobal\tmode=disabled (global override, default=model)\tShared skill\t/home/user/.agents/skills/shared-skill/SKILL.md",
    ),
  );
  assert.ok(
    skillsText.includes(
      "ws-skill\tworkspace\tmode=model (project override, default=user, global=disabled)\tWorkspace skill\t/ws/.agents/skills/ws-skill/SKILL.md",
    ),
  );
  assert.ok(skillsText.includes("Skill diagnostics:"));
  assert.ok(
    skillsText.includes(
      "- [collision] (shared-skill) /ws/.agents/skills/dup/SKILL.md: Duplicate skill name",
    ),
  );
  assert.ok(
    skillsText.includes("- [error] /ws/.agents/skills/broken/SKILL.md: Missing description"),
  );

  const statusText = formatMcpStatus(
    [
      {
        name: "docs",
        status: "connected",
        enabled: true,
        toolCount: 4,
        transport: "http",
        exposure: "codemode",
        roles: { router: true, worker: false },
        hasResources: true,
        scope: "override",
        recentLogs: ["[info] initialized"],
      },
      {
        name: "oauth-srv",
        status: "auth_required",
        enabled: true,
        toolCount: 0,
        transport: "http",
        exposure: "direct",
        roles: { router: true, worker: true },
        hasResources: false,
        authRequired: true,
        scope: "global",
      },
      {
        name: "degraded-auth",
        status: "disconnected",
        enabled: true,
        toolCount: 0,
        authRequired: true,
        error: "token expired",
      },
      {
        name: "off-srv",
        status: "disabled",
        enabled: false,
        toolCount: 0,
      },
    ],
    { showLogs: true },
  );
  assert.ok(
    statusText.includes(
      "docs\tconnected\ttools=4\ttransport=http\texposure=codemode\troles=router\tresources\tscope=override",
    ),
  );
  assert.ok(statusText.includes("  logs:\n    [info] initialized"));
  assert.ok(
    statusText.includes(
      "oauth-srv\tauth_required\ttools=0\ttransport=http\texposure=direct\troles=router,worker\tscope=global",
    ),
  );
  assert.ok(
    statusText.includes("degraded-auth\tdisconnected\ttools=0\tauth_required\terror=token expired"),
  );
  assert.ok(statusText.includes("off-srv\tdisabled\ttools=0"));
  assert.ok(statusText.includes("  logs: (none)"));

  const projectMcpText = formatProjectMcpState(
    {
      globalServers: {
        shared: { command: "shared" },
        base: { command: "base" },
      },
      projectServers: {
        shared: { enabled: false },
        local: { command: "local" },
      },
      effectiveServers: {
        shared: { command: "shared", enabled: false },
        base: { command: "base" },
        local: { command: "local" },
      },
      status: [
        { name: "shared", status: "disabled", enabled: false, toolCount: 0 },
        { name: "base", status: "connected", enabled: true, toolCount: 1 },
        { name: "local", status: "connected", enabled: true, toolCount: 2, scope: "project" },
      ],
    },
    {
      logs: new Map([
        ["local", { server: "local", lines: ["started"], logPath: "/tmp/proj/mcp.log" }],
      ]),
    },
  );
  assert.ok(projectMcpText.includes("shared\tdisabled\ttools=0\tscope=override"));
  assert.ok(projectMcpText.includes("base\tconnected\ttools=1\tscope=global"));
  assert.ok(projectMcpText.includes("local\tconnected\ttools=2\tscope=project"));
  assert.ok(projectMcpText.includes("  logs (/tmp/proj/mcp.log):\n    started"));

  assert.equal(
    formatMcpLogs({ server: "docs", lines: [], logPath: "/tmp/mcp.log" }),
    "MCP logs for docs (/tmp/mcp.log):\nNo log entries.",
  );
  assert.equal(
    formatMcpLogs({ server: "docs", lines: ["line 1", "line 2"] }),
    "MCP logs for docs:\nline 1\nline 2",
  );
});

async function readHttpJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function writeHttpJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function runCliSubprocess(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const cliEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=eevee-source", cliEntry, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

test("skills and MCP CLI commands dispatch expected API requests and handle OAuth outcomes", async () => {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  let globalPolicy: Record<string, "model" | "user" | "disabled"> = { existing: "user" };
  let projectPolicy: Record<string, "model" | "user" | "disabled"> | undefined = {
    "proj-skill": "disabled",
  };
  let globalMcpServers: Record<string, Record<string, unknown>> = {};
  let projectMcpServers: Record<string, Record<string, unknown>> = {};
  let oauthMode: "complete" | "error" | "hang" = "complete";

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/skills") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        skills: [
          {
            name: "existing",
            description: "Global skill",
            path: "/home/.agents/skills/existing/SKILL.md",
            baseDir: "/home/.agents/skills/existing",
            source: "global",
            disableModelInvocation: false,
            defaultMode: "model",
            effectiveMode: globalPolicy.existing ?? "model",
            ...(globalPolicy.existing === undefined
              ? {}
              : { globalOverride: globalPolicy.existing }),
          },
        ],
        diagnostics: [],
        globalPolicy,
      });
      return;
    }
    if (method === "PUT" && url === "/skills/policy") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      globalPolicy =
        body.policy === null ? {} : (body.policy as Record<string, "model" | "user" | "disabled">);
      writeHttpJson(res, 200, { skills: [], diagnostics: [], globalPolicy });
      return;
    }
    if (method === "GET" && url === "/projects/demo/skills") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        skills: [],
        diagnostics: [],
        globalPolicy,
        ...(projectPolicy === undefined ? {} : { projectPolicy }),
      });
      return;
    }
    if (method === "PUT" && url === "/projects/demo/skills/policy") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      projectPolicy =
        body.policy === null
          ? undefined
          : (body.policy as Record<string, "model" | "user" | "disabled">);
      writeHttpJson(res, 200, {
        skills: [],
        diagnostics: [],
        globalPolicy,
        ...(projectPolicy === undefined ? {} : { projectPolicy }),
      });
      return;
    }
    if (method === "GET" && url === "/projects/demo/mcp") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        globalServers: { docs: { url: "https://docs.example/mcp" } },
        projectServers: projectMcpServers,
        effectiveServers: {
          docs: { url: "https://docs.example/mcp", ...(projectMcpServers.docs ?? {}) },
        },
        status: [
          {
            name: "docs",
            status: "connected",
            enabled: true,
            toolCount: 1,
            transport: "http",
            exposure: "codemode",
            roles: { router: false, worker: false },
            scope: Object.hasOwn(projectMcpServers, "docs") ? "override" : "global",
          },
        ],
      });
      return;
    }
    if (method === "GET" && url === "/projects/demo/mcp/servers/docs/logs") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        server: "docs",
        lines: ["[info] project log line"],
        logPath: "/tmp/demo/mcp.log",
      });
      return;
    }
    if (method === "PUT" && url === "/projects/demo/mcp/servers/docs") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      projectMcpServers = {
        ...projectMcpServers,
        docs: body.config as Record<string, unknown>,
      };
      writeHttpJson(res, 200, {
        globalServers: { docs: { url: "https://docs.example/mcp" } },
        projectServers: projectMcpServers,
        effectiveServers: {
          docs: { url: "https://docs.example/mcp", ...(projectMcpServers.docs ?? {}) },
        },
        status: [{ name: "docs", status: "connected", enabled: true, toolCount: 1 }],
      });
      return;
    }
    if (method === "PUT" && url === "/projects/demo/mcp") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      projectMcpServers = body.servers as Record<string, Record<string, unknown>>;
      writeHttpJson(res, 200, {
        globalServers: {},
        projectServers: projectMcpServers,
        effectiveServers: projectMcpServers,
        status: [{ name: "docs", status: "connected", enabled: true, toolCount: 1 }],
      });
      return;
    }
    if (method === "DELETE" && url === "/projects/demo/mcp/servers/docs") {
      calls.push({ method, url });
      const next = { ...projectMcpServers };
      delete next.docs;
      projectMcpServers = next;
      writeHttpJson(res, 200, {
        globalServers: { docs: { url: "https://docs.example/mcp" } },
        projectServers: projectMcpServers,
        effectiveServers: { docs: { url: "https://docs.example/mcp" } },
        status: [],
      });
      return;
    }
    if (method === "POST" && url === "/projects/demo/mcp/reconnect") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      writeHttpJson(res, 200, {
        status: [
          { name: "docs", status: "connected", enabled: true, toolCount: 1, scope: "project" },
        ],
      });
      return;
    }
    if (method === "GET" && url === "/mcp") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        servers: globalMcpServers,
        status: [
          {
            name: "local",
            status: "connected",
            enabled: true,
            toolCount: 0,
            transport: "stdio",
            exposure: "codemode",
            roles: { router: false, worker: true },
            scope: "global",
          },
        ],
      });
      return;
    }
    if (method === "GET" && url === "/mcp/servers/local/logs") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        server: "local",
        lines: ["[info] global log line"],
        logPath: "/tmp/mcp.log",
      });
      return;
    }
    if (method === "PUT" && url === "/mcp/servers/local") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      globalMcpServers = {
        ...globalMcpServers,
        local: body.config as Record<string, unknown>,
      };
      writeHttpJson(res, 200, {
        servers: globalMcpServers,
        status: [{ name: "local", status: "connected", enabled: true, toolCount: 0 }],
      });
      return;
    }
    if (method === "POST" && url === "/mcp/servers/oauth-srv/oauth/login") {
      calls.push({ method, url });
      writeHttpJson(res, 201, { sessionId: "sess-1", server: "oauth-srv" });
      return;
    }
    if (method === "GET" && url === "/mcp/servers/oauth-srv/oauth/login/sess-1/stream") {
      calls.push({ method, url });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(
        `event: auth_url\ndata: ${JSON.stringify({
          type: "auth_url",
          url: "https://auth.example/authorize",
          redirectUrl: "http://127.0.0.1:9999/callback",
          instructions: "Open browser to sign in.",
        })}\n\n`,
      );
      if (oauthMode === "complete") {
        res.write(
          `event: progress\ndata: ${JSON.stringify({ type: "progress", message: "Exchanging code..." })}\n\n`,
        );
        res.write(`event: complete\ndata: ${JSON.stringify({ type: "complete" })}\n\n`);
        res.end();
      } else if (oauthMode === "error") {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            code: "oauth_denied",
            message: "Access denied",
          })}\n\n`,
        );
        res.end();
      } else {
        req.on("close", () => res.end());
      }
      return;
    }
    if (method === "POST" && url === "/mcp/servers/oauth-srv/oauth/login/sess-1/cancel") {
      calls.push({ method, url });
      writeHttpJson(res, 200, { ok: true });
      return;
    }
    if (method === "DELETE" && url === "/mcp/servers/oauth-srv/oauth") {
      calls.push({ method, url });
      writeHttpJson(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && url === "/projects/demo/mcp/servers/oauth-srv/oauth/login") {
      calls.push({ method, url });
      writeHttpJson(res, 201, { sessionId: "proj-sess-1", server: "oauth-srv" });
      return;
    }
    if (
      method === "GET" &&
      url === "/projects/demo/mcp/servers/oauth-srv/oauth/login/proj-sess-1/stream"
    ) {
      calls.push({ method, url });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(
        `event: auth_url\ndata: ${JSON.stringify({
          type: "auth_url",
          url: "https://auth.example/project-authorize",
          redirectUrl: "http://127.0.0.1:9999/callback",
          instructions: "Open browser to sign in for project.",
        })}\n\n`,
      );
      if (oauthMode === "complete") {
        res.write(
          `event: progress\ndata: ${JSON.stringify({ type: "progress", message: "Exchanging code..." })}\n\n`,
        );
        res.write(`event: complete\ndata: ${JSON.stringify({ type: "complete" })}\n\n`);
        res.end();
      } else if (oauthMode === "error") {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            code: "oauth_denied",
            message: "Project access denied",
          })}\n\n`,
        );
        res.end();
      } else {
        req.on("close", () => res.end());
      }
      return;
    }
    if (
      method === "POST" &&
      url === "/projects/demo/mcp/servers/oauth-srv/oauth/login/proj-sess-1/cancel"
    ) {
      calls.push({ method, url });
      writeHttpJson(res, 200, { ok: true });
      return;
    }
    if (method === "DELETE" && url === "/projects/demo/mcp/servers/oauth-srv/oauth") {
      calls.push({ method, url });
      writeHttpJson(res, 200, { ok: true });
      return;
    }
    writeHttpJson(res, 404, { code: "not_found", message: `Unhandled ${method} ${url}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env: NodeJS.ProcessEnv = {
    EEVEE_HOME: "/tmp/eevee-cli-mock-test",
    EEVEE_URL: `http://127.0.0.1:${address.port}`,
    EEVEE_TOKEN: "test-token",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const run = (argv: string[]) => createProgram(env).parseAsync(["node", "eevee", ...argv]);

    logs.length = 0;
    await run(["skills", "list"]);
    assert.ok(logs[0]?.includes("existing\tglobal\tmode=user (global override, default=model)"));

    logs.length = 0;
    await run(["skills", "list", "--project", "demo", "--json"]);
    assert.equal(JSON.parse(logs[0] ?? "{}").projectPolicy["proj-skill"], "disabled");

    await run(["skills", "set-policy", "new-skill", "disabled"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/skills/policy",
      body: { policy: { existing: "user", "new-skill": "disabled" } },
    });

    await run(["skills", "set-policy", "proj-skill", "reset", "--project", "demo"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/projects/demo/skills/policy",
      body: { policy: null },
    });

    await run(["skills", "clear-policy"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/skills/policy",
      body: { policy: null },
    });

    await run(["mcp", "add", "docs", "--project", "demo", "--no-router", "--no-worker"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/projects/demo/mcp/servers/docs",
      body: { config: { roles: { router: false, worker: false } } },
    });

    await run(["mcp", "add", "local", "--command", "npx", "--no-router"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/mcp/servers/local",
      body: { config: { command: "npx", roles: { router: false, worker: true } } },
    });

    await run(["mcp", "reconnect", "docs", "--project", "demo"]);
    assert.deepEqual(calls.at(-1), {
      method: "POST",
      url: "/projects/demo/mcp/reconnect",
      body: { server: "docs" },
    });

    await run(["mcp", "remove", "docs", "--project", "demo"]);
    assert.deepEqual(calls.at(-1), {
      method: "DELETE",
      url: "/projects/demo/mcp/servers/docs",
    });

    logs.length = 0;
    await run(["mcp", "status", "--logs"]);
    assert.ok(logs[0]?.includes("[info] global log line"));

    logs.length = 0;
    await run(["mcp", "status", "--project", "demo", "--logs"]);
    assert.ok(logs[0]?.includes("docs\tconnected\ttools=1"));
    assert.ok(logs[0]?.includes("[info] project log line"));

    logs.length = 0;
    await run(["mcp", "logs", "docs", "--project", "demo"]);
    assert.ok(logs[0]?.includes("MCP logs for docs (/tmp/demo/mcp.log):\n[info] project log line"));

    oauthMode = "complete";
    const loginOk = await runCliSubprocess(["mcp", "login", "oauth-srv"], env);
    assert.equal(loginOk.code, 0, loginOk.stderr);
    assert.ok(loginOk.stdout.includes("Open URL: https://auth.example/authorize"));
    assert.ok(loginOk.stdout.includes("Open browser to sign in."));
    assert.ok(loginOk.stdout.includes("Exchanging code..."));
    assert.ok(loginOk.stdout.includes("Authenticated MCP server oauth-srv"));

    oauthMode = "error";
    const loginErr = await runCliSubprocess(["mcp", "login", "oauth-srv"], env);
    assert.equal(loginErr.code, 1);
    assert.ok(loginErr.stderr.includes("Access denied (oauth_denied)"));

    const loginErrJson = await runCliSubprocess(["mcp", "login", "oauth-srv", "--json"], env);
    assert.equal(loginErrJson.code, 1);
    assert.deepEqual(JSON.parse(loginErrJson.stdout), {
      type: "error",
      code: "oauth_denied",
      message: "Access denied",
    });

    oauthMode = "hang";
    const beforeSigint = new Set(process.listeners("SIGINT"));
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const loginPromise = run(["mcp", "login", "oauth-srv", "--json"]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const addedSigint = process
        .listeners("SIGINT")
        .filter((listener) => !beforeSigint.has(listener));
      assert.equal(addedSigint.length, 1);
      addedSigint[0]?.("SIGINT");
      await loginPromise;
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    assert.ok(
      calls.some(
        (c) => c.method === "POST" && c.url === "/mcp/servers/oauth-srv/oauth/login/sess-1/cancel",
      ),
    );

    logs.length = 0;
    await run(["mcp", "logout", "oauth-srv"]);
    assert.ok(logs.includes("Logged out of MCP server oauth-srv"));

    oauthMode = "complete";
    const projLoginOk = await runCliSubprocess(
      ["mcp", "login", "oauth-srv", "--project", "demo"],
      env,
    );
    assert.equal(projLoginOk.code, 0, projLoginOk.stderr);
    assert.ok(projLoginOk.stdout.includes("Open URL: https://auth.example/project-authorize"));
    assert.ok(projLoginOk.stdout.includes("Open browser to sign in for project."));
    assert.ok(projLoginOk.stdout.includes("Authenticated MCP server oauth-srv"));

    const projLoginJson = await runCliSubprocess(
      ["mcp", "login", "oauth-srv", "--project", "demo", "--json"],
      env,
    );
    assert.equal(projLoginJson.code, 0, projLoginJson.stderr);
    assert.deepEqual(JSON.parse(projLoginJson.stdout), {
      ok: true,
      server: "oauth-srv",
      projectId: "demo",
    });

    oauthMode = "error";
    const projLoginErr = await runCliSubprocess(
      ["mcp", "login", "oauth-srv", "--project", "demo"],
      env,
    );
    assert.equal(projLoginErr.code, 1);
    assert.ok(projLoginErr.stderr.includes("Project access denied (oauth_denied)"));

    oauthMode = "hang";
    const beforeProjSigint = new Set(process.listeners("SIGINT"));
    const originalStderrWrite2 = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const loginPromise = run(["mcp", "login", "oauth-srv", "--project", "demo", "--json"]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const addedSigint = process
        .listeners("SIGINT")
        .filter((listener) => !beforeProjSigint.has(listener));
      assert.equal(addedSigint.length, 1);
      addedSigint[0]?.("SIGINT");
      await loginPromise;
    } finally {
      process.stderr.write = originalStderrWrite2;
    }
    assert.ok(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url === "/projects/demo/mcp/servers/oauth-srv/oauth/login/proj-sess-1/cancel",
      ),
    );

    logs.length = 0;
    await run(["mcp", "logout", "oauth-srv", "--project", "demo"]);
    assert.ok(logs.includes("Logged out of MCP server oauth-srv"));
    assert.ok(
      calls.some(
        (c) => c.method === "DELETE" && c.url === "/projects/demo/mcp/servers/oauth-srv/oauth",
      ),
    );
  } finally {
    console.log = originalLog;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("merge helpers combine project models, tool settings, and MCP add configs cleanly", () => {
  assert.deepEqual(
    mergeProjectModels(
      {
        worker: { provider: "anthropic", modelId: "claude-sonnet" },
        dreamer: { provider: "openai", modelId: "gpt-4o-mini" },
      },
      { router: { provider: "openai", modelId: "gpt-4o" } },
    ),
    {
      router: { provider: "openai", modelId: "gpt-4o" },
      worker: { provider: "anthropic", modelId: "claude-sonnet" },
      dreamer: { provider: "openai", modelId: "gpt-4o-mini" },
    },
  );

  assert.deepEqual(
    mergeToolsSettings(
      {
        router: { ls: false },
        worker: { bash: false },
        codemode: { mode: "on", inlineBudget: 800 },
      },
      {
        worker: { powershell: true },
        codemode: { mode: "only" },
      },
    ),
    {
      router: { ls: false },
      worker: { bash: false, powershell: true },
      codemode: { mode: "only", inlineBudget: 800 },
    },
  );

  assert.deepEqual(mergeToolsSettings(undefined, { worker: { powershell: true } }), {
    worker: { powershell: true },
  });

  // Brand-new full server defaults missing role to true; partial override does not.
  assert.deepEqual(
    mergeMcpAddConfig(
      undefined,
      { command: "npx", roles: { router: false } },
      { isPartialOverride: false, switchTransport: false },
    ),
    { command: "npx", roles: { router: false, worker: true } },
  );
  assert.deepEqual(
    mergeMcpAddConfig(
      undefined,
      { roles: { worker: false } },
      { isPartialOverride: true, switchTransport: false },
    ),
    { roles: { worker: false } },
  );

  // Merging stdio -> http and http -> stdio drops old transport fields while preserving shared ones.
  assert.deepEqual(
    mergeMcpAddConfig(
      {
        type: "http",
        url: "https://old.example/mcp",
        headers: { Authorization: "Bearer secret" },
        oauth: { clientId: "cid" },
        exposure: "direct",
        toolExposure: { search: "hidden" },
        description: "Docs",
        timeout: 30,
        enabled: false,
        roles: { router: false, worker: true },
      },
      { command: "npx", args: ["-y", "docs-mcp"], env: { LOG: "1" } },
      { isPartialOverride: false, switchTransport: true },
    ),
    {
      command: "npx",
      args: ["-y", "docs-mcp"],
      env: { LOG: "1" },
      exposure: "direct",
      toolExposure: { search: "hidden" },
      description: "Docs",
      timeout: 30,
      enabled: false,
      roles: { router: false, worker: true },
    },
  );

  assert.deepEqual(
    mergeMcpAddConfig(
      {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp"],
        cwd: "/repo",
        env: { LOG: "1" },
        exposure: "deferred",
        roles: { router: true, worker: false },
      },
      { url: "https://new.example/mcp", headers: { "X-Team": "ai" } },
      { isPartialOverride: false, switchTransport: true },
    ),
    {
      url: "https://new.example/mcp",
      headers: { "X-Team": "ai" },
      exposure: "deferred",
      roles: { router: true, worker: false },
    },
  );
});

test("project update and mcp add merge existing configuration by default and support --replace", async () => {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];

  let project = {
    id: "demo",
    title: "Demo",
    workspaces: ["/ws/demo"],
    models: {
      router: { provider: "openai", modelId: "gpt-4o-mini" },
      worker: { provider: "anthropic", modelId: "claude-sonnet" },
      dreamer: { provider: "openai", modelId: "gpt-4o-mini" },
    },
    tools: {
      router: { ls: false, grep: true },
      worker: { bash: false },
      codemode: { mode: "on", inlineBudget: 1200 },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  let globalServers: Record<string, Record<string, unknown>> = {
    docs: {
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer old", "X-Keep": "1" },
      oauth: { clientId: "cid-1", scope: "read" },
      exposure: "direct",
      toolExposure: { query: "hidden" },
      roles: { router: true, worker: false },
      description: "Docs server",
      timeout: 45,
      enabled: true,
    },
    stdio: {
      type: "stdio",
      command: "npx",
      args: ["-y", "mcp-stdio"],
      cwd: "/ws/demo",
      env: { NODE_ENV: "production", DEBUG: "0" },
      exposure: "deferred",
      roles: { router: false, worker: true },
    },
  };

  let projectServers: Record<string, Record<string, unknown>> = {
    docs: {
      exposure: "direct",
      roles: { router: false },
    },
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/projects/demo") {
      calls.push({ method, url });
      writeHttpJson(res, 200, { project });
      return;
    }
    if (method === "PATCH" && url === "/projects/demo") {
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      project = {
        ...project,
        ...(body.models === null
          ? {}
          : body.models !== undefined
            ? { models: body.models as typeof project.models }
            : {}),
        ...(body.tools === null
          ? {}
          : body.tools !== undefined
            ? { tools: body.tools as typeof project.tools }
            : {}),
      };
      writeHttpJson(res, 200, { project });
      return;
    }
    if (method === "GET" && url === "/mcp") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        servers: globalServers,
        status: Object.keys(globalServers).map((name) => ({
          name,
          status: "connected",
          enabled: true,
          toolCount: 0,
        })),
      });
      return;
    }
    if (method === "PUT" && url.startsWith("/mcp/servers/")) {
      const name = decodeURIComponent(url.slice("/mcp/servers/".length));
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      globalServers = {
        ...globalServers,
        [name]: body.config as Record<string, unknown>,
      };
      writeHttpJson(res, 200, {
        servers: globalServers,
        status: Object.keys(globalServers).map((serverName) => ({
          name: serverName,
          status: "connected",
          enabled: true,
          toolCount: 0,
        })),
      });
      return;
    }
    if (method === "GET" && url === "/projects/demo/mcp") {
      calls.push({ method, url });
      writeHttpJson(res, 200, {
        globalServers,
        projectServers,
        effectiveServers: globalServers,
        status: [],
      });
      return;
    }
    if (method === "PUT" && url.startsWith("/projects/demo/mcp/servers/")) {
      const name = decodeURIComponent(url.slice("/projects/demo/mcp/servers/".length));
      const body = await readHttpJson(req);
      calls.push({ method, url, body });
      projectServers = {
        ...projectServers,
        [name]: body.config as Record<string, unknown>,
      };
      writeHttpJson(res, 200, {
        globalServers,
        projectServers,
        effectiveServers: globalServers,
        status: [],
      });
      return;
    }
    writeHttpJson(res, 404, { code: "not_found", message: `Unhandled ${method} ${url}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env: NodeJS.ProcessEnv = {
    EEVEE_HOME: "/tmp/eevee-cli-merge-test",
    EEVEE_URL: `http://127.0.0.1:${address.port}`,
    EEVEE_TOKEN: "test-token",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const run = (argv: string[]) => createProgram(env).parseAsync(["node", "eevee", ...argv]);

    // 1. project update --router-model preserves existing worker & dreamer slots
    await run(["project", "update", "demo", "--router-model", "openai/gpt-5"]);
    assert.deepEqual(calls.at(-1), {
      method: "PATCH",
      url: "/projects/demo",
      body: {
        models: {
          router: { provider: "openai", modelId: "gpt-5" },
          worker: { provider: "anthropic", modelId: "claude-sonnet" },
          dreamer: { provider: "openai", modelId: "gpt-4o-mini" },
        },
      },
    });

    // 2. project update --worker-tools +powershell preserves router tools & codemode settings
    await run(["project", "update", "demo", "--worker-tools", "+powershell"]);
    assert.deepEqual(calls.at(-1), {
      method: "PATCH",
      url: "/projects/demo",
      body: {
        tools: {
          router: { ls: false, grep: true },
          worker: { bash: false, powershell: true },
          codemode: { mode: "on", inlineBudget: 1200 },
        },
      },
    });

    // 3. project update --codemode-mode preserves inlineBudget & tool maps
    await run(["project", "update", "demo", "--codemode-mode", "only"]);
    assert.deepEqual(calls.at(-1), {
      method: "PATCH",
      url: "/projects/demo",
      body: {
        tools: {
          router: { ls: false, grep: true },
          worker: { bash: false, powershell: true },
          codemode: { mode: "only", inlineBudget: 1200 },
        },
      },
    });

    // 4. mcp add on existing global HTTP server preserves headers, oauth, roles, exposure, toolExposure
    await run([
      "mcp",
      "add",
      "docs",
      "--url",
      "https://docs.example/v2",
      "--header",
      "Authorization=Bearer new",
      "--no-router",
    ]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/mcp/servers/docs",
      body: {
        config: {
          url: "https://docs.example/v2",
          headers: { Authorization: "Bearer new", "X-Keep": "1" },
          oauth: { clientId: "cid-1", scope: "read" },
          exposure: "direct",
          toolExposure: { query: "hidden" },
          roles: { router: false, worker: false },
          description: "Docs server",
          timeout: 45,
          enabled: true,
        },
      },
    });

    // 5. mcp add --replace replaces existing global server wholesale without fetching GET /mcp
    const callsBeforeReplace = calls.length;
    await run([
      "mcp",
      "add",
      "docs",
      "--url",
      "https://docs.example/fresh",
      "--header",
      "X-Only=yes",
      "--replace",
    ]);
    assert.equal(
      calls.slice(callsBeforeReplace).some((c) => c.method === "GET" && c.url === "/mcp"),
      false,
    );
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/mcp/servers/docs",
      body: {
        config: {
          url: "https://docs.example/fresh",
          headers: { "X-Only": "yes" },
        },
      },
    });

    // 6. mcp add switching stdio -> http drops command/args/cwd/env/type while keeping exposure & roles
    await run(["mcp", "add", "stdio", "--url", "https://stdio-now-http.example/mcp"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/mcp/servers/stdio",
      body: {
        config: {
          url: "https://stdio-now-http.example/mcp",
          exposure: "deferred",
          roles: { router: false, worker: true },
        },
      },
    });

    // 7. mcp add --project demo docs --no-worker preserves existing exposure & roles.router
    await run(["mcp", "add", "docs", "--project", "demo", "--no-worker"]);
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      url: "/projects/demo/mcp/servers/docs",
      body: {
        config: {
          exposure: "direct",
          roles: { router: false, worker: false },
        },
      },
    });
  } finally {
    console.log = originalLog;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("parseNonEmpty, withSignalAbort, and runEngineCommand handle normal, JSON, error, and abort paths", async () => {
  assert.equal(parseNonEmpty("docs", "server name"), "docs");
  assert.equal(parseNonEmpty(" w1 ", "workerId"), " w1 ");
  assert.throws(() => parseNonEmpty("", "taskId"), /Invalid taskId: must not be empty/);
  assert.throws(
    () => parseNonEmpty(" \t\n ", "server name"),
    /Invalid server name: must not be empty/,
  );

  const beforeSigint = process.listenerCount("SIGINT");
  const beforeSigterm = process.listenerCount("SIGTERM");

  const normalValue = await withSignalAbort(async () => 42);
  assert.equal(normalValue, 42);
  assert.equal(process.listenerCount("SIGINT"), beforeSigint);
  assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);

  await assert.rejects(
    withSignalAbort(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(process.listenerCount("SIGINT"), beforeSigint);

  let abortedCallbackCalled = false;
  const beforeSet = new Set(process.listeners("SIGINT"));
  const abortPromise = withSignalAbort(
    (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    () => {
      abortedCallbackCalled = true;
    },
  );
  const addedSigint = process.listeners("SIGINT").filter((listener) => !beforeSet.has(listener));
  assert.equal(addedSigint.length, 1);
  addedSigint[0]?.("SIGINT");
  const abortedResult = await abortPromise;
  assert.equal(abortedResult, undefined);
  assert.equal(abortedCallbackCalled, true);
  assert.equal(process.listenerCount("SIGINT"), beforeSigint);

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/settings") {
      writeHttpJson(res, 200, { maxActiveWorkers: 3 });
      return;
    }
    writeHttpJson(res, 404, { code: "not_found", message: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env: NodeJS.ProcessEnv = {
    EEVEE_HOME: "/tmp/eevee-cli-helper-test",
    EEVEE_URL: `http://127.0.0.1:${address.port}`,
    EEVEE_TOKEN: "test-token",
  };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await runEngineCommand(
      env,
      {},
      (client) => client.getSettings(),
      (settings) => `workers=${settings.maxActiveWorkers}`,
    );
    assert.equal(logs[0], "workers=3");

    logs.length = 0;
    await runEngineCommand(
      env,
      { json: true },
      (client) => client.getSettings(),
      () => "should-not-format",
    );
    assert.deepEqual(JSON.parse(logs[0] ?? "{}"), { maxActiveWorkers: 3 });
  } finally {
    console.log = originalLog;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("login-ui drives provider login (menu, auth events, select, secret echo muting) and MCP OAuth", async () => {
  const submittedInputs: Array<{ url: string; body: Record<string, unknown> }> = [];
  const cancelledUrls: string[] = [];
  let mcpMode: "complete" | "error" | "eof" = "complete";

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/providers") {
      writeHttpJson(res, 200, {
        providers: [
          {
            id: "dual",
            name: "Dual Provider",
            authMethods: {
              apiKey: true,
              apiKeyLogin: true,
              oauth: true,
              oauthLabel: "Browser OAuth",
            },
            configured: false,
            modelCount: 1,
          },
          {
            id: "apikey-only",
            name: "API Key Only",
            authMethods: { apiKey: true, apiKeyLogin: false, oauth: false },
            configured: false,
            modelCount: 1,
          },
        ],
      });
      return;
    }
    if (method === "POST" && url === "/providers/dual/auth/login") {
      const body = await readHttpJson(req);
      writeHttpJson(res, 201, { sessionId: "prov-1", providerId: "dual", type: body.type });
      return;
    }
    if (method === "GET" && url === "/providers/dual/auth/login/prov-1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        `event: auth\ndata: ${JSON.stringify({
          type: "auth_url",
          url: "https://dual.example/auth",
          instructions: "Sign in via browser",
        })}\n\n`,
      );
      res.write(
        `event: auth\ndata: ${JSON.stringify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://dual.example/device",
        })}\n\n`,
      );
      res.write(
        `event: prompt\ndata: ${JSON.stringify({
          promptId: "p-region",
          type: "select",
          message: "Pick region",
          options: [
            { id: "us", label: "US East", description: "Default" },
            { id: "eu", label: "EU West" },
          ],
        })}\n\n`,
      );
      res.write(
        `event: prompt\ndata: ${JSON.stringify({
          promptId: "p-secret",
          type: "secret",
          message: "Enter secret token",
        })}\n\n`,
      );
      res.write(
        `event: complete\ndata: ${JSON.stringify({ providerId: "dual", type: "oauth" })}\n\n`,
      );
      res.end();
      return;
    }
    if (method === "POST" && url === "/providers/dual/auth/login/prov-1/input") {
      submittedInputs.push({ url, body: await readHttpJson(req) });
      writeHttpJson(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && url === "/providers/dual/auth/login/prov-1/cancel") {
      cancelledUrls.push(url);
      writeHttpJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/projects/demo/mcp/servers/docs/oauth/login") {
      writeHttpJson(res, 201, { sessionId: "mcp-1", server: "docs" });
      return;
    }
    if (method === "GET" && url === "/projects/demo/mcp/servers/docs/oauth/login/mcp-1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        `event: auth_url\ndata: ${JSON.stringify({
          type: "auth_url",
          url: "https://mcp.example/authorize",
          redirectUrl: "http://127.0.0.1:4000/cb",
          instructions: "Paste redirect URL below.",
        })}\n\n`,
      );
      if (mcpMode === "eof") {
        res.end();
        return;
      }
      if (mcpMode === "error") {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            code: "access_denied",
            message: "User denied",
          })}\n\n`,
        );
        res.end();
        return;
      }
      // Keep stream open until redirect URL input arrives, then finish with complete.
      const checkDone = setInterval(() => {
        if (submittedInputs.some((entry) => entry.url.endsWith("/mcp-1/input"))) {
          clearInterval(checkDone);
          res.write(
            `event: progress\ndata: ${JSON.stringify({ type: "progress", message: "Verified!" })}\n\n`,
          );
          res.write(`event: complete\ndata: ${JSON.stringify({ type: "complete" })}\n\n`);
          res.end();
        }
      }, 15);
      req.on("close", () => clearInterval(checkDone));
      return;
    }
    if (method === "POST" && url === "/projects/demo/mcp/servers/docs/oauth/login/mcp-1/input") {
      submittedInputs.push({ url, body: await readHttpJson(req) });
      writeHttpJson(res, 200, { ok: true });
      return;
    }
    writeHttpJson(res, 404, { code: "not_found", message: `Unhandled ${method} ${url}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new EeveeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "test-token",
  });

  const collectStream = (stream: PassThrough) => {
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    return () => text;
  };

  try {
    await assert.rejects(
      runProviderLogin({ client, providerId: "missing" }),
      /Unknown provider "missing"/,
    );
    await assert.rejects(
      runProviderLogin({ client, providerId: "apikey-only", oauth: true }),
      /does not support OAuth login/,
    );
    await assert.rejects(
      runProviderLogin({ client, providerId: "apikey-only" }),
      /does not support interactive login; pass --api-key <key>/,
    );

    // Provider login in JSON mode routes prompts & auth events to stderr and mutes secret echo.
    const provIn = new PassThrough();
    const provOut = new PassThrough();
    const provErr = new PassThrough();
    const readProvOut = collectStream(provOut);
    const readProvErr = collectStream(provErr);

    const provPromise = runProviderLogin({
      client,
      providerId: "dual",
      json: true,
      streams: { stdin: provIn, stdout: provOut, stderr: provErr, isTTY: true },
    });

    const waitForPrompt = async (read: () => string, needle: string) => {
      const deadline = Date.now() + 2000;
      while (!read().includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for "${needle}" in:\n${read()}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    await waitForPrompt(readProvErr, "Select [1/2]: ");
    provIn.write("1\n");
    await waitForPrompt(readProvErr, "Select option: ");
    provIn.write("2\n");
    await waitForPrompt(readProvErr, "Enter secret token: ");
    provIn.write("super-secret-token\n");

    const provResult = await provPromise;
    assert.deepEqual(provResult, { providerId: "dual", type: "oauth" });
    assert.equal(readProvOut(), "");
    const errText = readProvErr();
    assert.ok(errText.includes("Open URL: https://dual.example/auth"));
    assert.ok(errText.includes("Enter code ABCD-1234 at https://dual.example/device"));
    assert.ok(errText.includes("1) US East (us) — Default"));
    assert.equal(errText.includes("super-secret-token"), false);
    assert.deepEqual(submittedInputs.slice(0, 2), [
      {
        url: "/providers/dual/auth/login/prov-1/input",
        body: { promptId: "p-region", value: "eu" },
      },
      {
        url: "/providers/dual/auth/login/prov-1/input",
        body: { promptId: "p-secret", value: "super-secret-token" },
      },
    ]);

    // MCP OAuth manual redirect prompt + completion in human mode
    mcpMode = "complete";
    const mcpIn = new PassThrough();
    const mcpOut = new PassThrough();
    const mcpErr = new PassThrough();
    const readMcpOut = collectStream(mcpOut);
    const mcpPromise = runMcpOAuthLogin({
      client,
      serverName: "docs",
      projectId: "demo",
      streams: { stdin: mcpIn, stdout: mcpOut, stderr: mcpErr, isTTY: true },
    });
    await waitForPrompt(readMcpOut, "Paste redirect URL");
    mcpIn.write("http://127.0.0.1:4000/cb?code=xyz\n");
    const mcpResult = await mcpPromise;
    assert.deepEqual(mcpResult, { ok: true, server: "docs", projectId: "demo" });
    assert.ok(readMcpOut().includes("Open URL: https://mcp.example/authorize"));
    assert.ok(readMcpOut().includes("Verified!"));
    assert.deepEqual(submittedInputs.at(-1), {
      url: "/projects/demo/mcp/servers/docs/oauth/login/mcp-1/input",
      body: { redirectUrl: "http://127.0.0.1:4000/cb?code=xyz" },
    });

    // MCP OAuth error in human mode throws, in JSON mode returns error event & sets exitCode=1
    mcpMode = "error";
    await assert.rejects(
      runMcpOAuthLogin({
        client,
        serverName: "docs",
        projectId: "demo",
        streams: {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          isTTY: false,
        },
      }),
      /User denied \(access_denied\)/,
    );

    const prevExitCode = process.exitCode;
    try {
      const mcpErrJson = await runMcpOAuthLogin({
        client,
        serverName: "docs",
        projectId: "demo",
        json: true,
        streams: {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          isTTY: false,
        },
      });
      assert.deepEqual(mcpErrJson, {
        type: "error",
        code: "access_denied",
        message: "User denied",
      });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = prevExitCode;
    }

    // MCP OAuth unexpected EOF throws
    mcpMode = "eof";
    await assert.rejects(
      runMcpOAuthLogin({
        client,
        serverName: "docs",
        projectId: "demo",
        streams: {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          isTTY: false,
        },
      }),
      /MCP OAuth sign-in stream ended unexpectedly/,
    );
    assert.equal(cancelledUrls.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
