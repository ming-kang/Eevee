import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseToolOverridesFlag, parseToolsSettingsFlags } from "../src/args.ts";
import {
  aggregateBoardTasks,
  ConversationWatchRenderer,
  formatBoard,
  formatMcpState,
  formatModelProfiles,
  formatModels,
  formatProbeResult,
  formatProjectUsage,
  formatProviderCatalog,
  formatProviderDetail,
  formatProviders,
  formatQuestionAnswered,
  formatRefreshModels,
  formatReloadModels,
  formatSettings,
  formatSmokeTestResult,
  formatTaskList,
  formatTaskOutput,
  parseModelFlag,
  TaskWatchRenderer,
} from "../src/format.ts";
import { createProgram } from "../src/index.ts";

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
