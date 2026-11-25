import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConversationWatchRenderer,
  formatBoard,
  formatMcpState,
  formatModelProfiles,
  formatModels,
  formatProjectUsage,
  formatProviders,
  formatQuestionAnswered,
  formatRefreshModels,
  formatSettings,
  formatTaskOutput,
  parseModelFlag,
} from "../src/format.ts";
import { createProgram } from "../src/index.ts";

test("CLI program registers core metadata and all 4A + 4B subcommands and options", () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  assert.equal(program.name(), "eevee");
  const commands = program.commands.map((command) => command.name());
  for (const expected of [
    "info",
    "start",
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
  assert.ok(taskSubcommands.includes("read"));
  assert.ok(taskSubcommands.includes("kill"));

  const taskReadCmd = taskCmd.commands.find((command) => command.name() === "read");
  assert.ok(taskReadCmd);
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--mode"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--bytes"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--since-bytes"));
  assert.ok(taskReadCmd.options.some((opt) => opt.long === "--json"));

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

test("eevee start without --foreground rejects cleanly in 4A", async () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  await assert.rejects(program.parseAsync(["node", "eevee", "start"]), /--foreground/);
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
  assert.deepEqual(modelsCmd.commands.map((c) => c.name()).sort(), ["list", "profiles", "refresh"]);
  const profilesCmd = modelsCmd.commands.find((c) => c.name() === "profiles");
  assert.deepEqual(profilesCmd?.commands.map((c) => c.name()).sort(), ["get", "set"]);
  const modelsList = modelsCmd.commands.find((c) => c.name() === "list");
  assert.ok(modelsList?.options.some((o) => o.long === "--provider"));
  assert.ok(modelsList?.options.some((o) => o.long === "--available"));

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
    }).includes("anthropic\tAnthropic\tconfigured (oauth: OAuth)"),
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
