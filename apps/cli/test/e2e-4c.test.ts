import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAuthToken, readEngineState } from "@eevee/engine";
import {
  ConfigBundleSchema,
  CreateProjectResponseSchema,
  DeleteProjectResponseSchema,
  EeveeClient,
  EngineSettingsSchema,
  GetProjectResponseSchema,
  ListEntriesResponseSchema,
  ListModelsResponseSchema,
  ListProvidersResponseSchema,
  McpStateResponseSchema,
  ModelProfilesDocumentSchema,
  ProjectMemoryResponseSchema,
  type ProjectUsageResponse,
  ProjectUsageResponseSchema,
  parseWithSchema,
  ReconnectMcpResponseSchema,
} from "@eevee/protocol";
import {
  CLI_ENTRY,
  lastUserOrToolMessage,
  type RecordedOpenAiRequest,
  type ScriptedOpenAiTurn,
  startE2eFixture,
  stopChildProcess,
  waitFor,
} from "./e2e-harness.ts";

function systemPromptOf(request: RecordedOpenAiRequest): string {
  const sys = request.body.messages.find((msg) => msg.role === "system");
  if (sys === undefined) return "";
  return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
}

function toolNamesOf(request: RecordedOpenAiRequest): string[] {
  if (!Array.isArray(request.body.tools)) return [];
  return request.body.tools
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return undefined;
      const fn = (entry as { function?: { name?: unknown } }).function;
      return typeof fn?.name === "string" ? fn.name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

const STDIO_MCP_SCRIPT = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (!("id" in msg)) return;
  const id = msg.id;
  if (msg.method === "initialize") {
    const protocolVersion = msg.params?.protocolVersion ?? "2025-11-25";
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "e2e-stdio-mcp", version: "1.0.0" },
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: "echo_tag",
          description: "Echo a tag from stdio MCP",
          inputSchema: {
            type: "object",
            properties: { tag: { type: "string" } },
            required: ["tag"],
          },
        }],
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    const tag = String(msg.params?.arguments?.tag ?? "");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "STDIO_MCP_OK:" + tag }],
      },
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  }) + "\\n");
});
rl.on("close", () => process.exit(0));
`;

test("Slice 4C E2E: auth, profiles, memory, live stdio MCP propagation, config export/import, Dreamer usage, and project removal", async () => {
  const fixture = await startE2eFixture({
    modelsConfig: (baseUrl) => ({
      providers: {
        mock: {
          baseUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "test-model",
              reasoning: false,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
            {
              id: "dreamer-model",
              reasoning: false,
              cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    resolveTurn: (request): ScriptedOpenAiTurn => {
      if (request.body.model === "dreamer-model") {
        return {
          textChunks: ["user: requested long memory summary cleanly"],
          usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
        };
      }

      const last = lastUserOrToolMessage(request);
      if (last.role === "user") {
        if (last.text.includes("turn-initial-long")) {
          return {
            toolCalls: [
              {
                name: "spawn_worker",
                arguments: { name: "helper", prompt: "worker-initial-warmup" },
              },
            ],
          };
        }
        if (last.text.includes("worker-initial-warmup")) {
          return { textChunks: ["Worker helper ready."] };
        }
        if (last.text.includes("Worker helper ready.")) {
          return {
            textChunks: ["Initial router reply acknowledging baseline setup."],
          };
        }
        if (last.text.includes("turn-after-memory-and-profiles")) {
          return {
            textChunks: ["Updated memory and model profiles visible."],
          };
        }
        if (last.text.includes("turn-call-stdio-mcp")) {
          return {
            toolCalls: [
              {
                name: "mcp__echomcp__echo_tag",
                arguments: { tag: "pineapple-4c" },
              },
            ],
          };
        }
        if (last.text.includes("worker-call-stdio-mcp")) {
          return {
            toolCalls: [
              {
                name: "mcp__echomcp__echo_tag",
                arguments: { tag: "worker-mcp-4c" },
              },
            ],
          };
        }
      }
      if (last.role === "tool") {
        if (last.toolName === "spawn_worker") {
          return { textChunks: ["Spawned helper worker."] };
        }
        if (last.toolName === "mcp__echomcp__echo_tag") {
          return {
            textChunks: [`MCP tool responded: ${last.text}`],
          };
        }
      }
      throw new Error(`Unexpected OpenAI request: ${JSON.stringify(last)}`);
    },
  });

  const extraDirs: string[] = [];

  try {
    const keepFile = join(fixture.workspaceDir, "workspace-keep.txt");
    await writeFile(keepFile, "must remain untouched", "utf8");

    const mcpScriptPath = join(fixture.rootDir, "mcp-fixture.mjs");
    await writeFile(mcpScriptPath, STDIO_MCP_SCRIPT, "utf8");

    const authStatusRes = await fixture.runCli(["auth", "status", "--json"]);
    assert.equal(authStatusRes.code, 0, authStatusRes.stderr);
    const providers = parseWithSchema(
      ListProvidersResponseSchema,
      JSON.parse(authStatusRes.stdout),
    );
    assert.equal(providers.providers.find((p) => p.id === "mock")?.configured, true);

    const modelsListRes = await fixture.runCli([
      "models",
      "list",
      "--provider",
      "mock",
      "--available",
      "--json",
    ]);
    assert.equal(modelsListRes.code, 0, modelsListRes.stderr);
    const modelsList = parseWithSchema(ListModelsResponseSchema, JSON.parse(modelsListRes.stdout));
    assert.equal(modelsList.models.length, 2);

    const configSetRes = await fixture.runCli([
      "config",
      "set",
      "--max-active-workers",
      "4",
      "--router-model",
      "mock/test-model",
      "--worker-model",
      "mock/test-model",
      "--dreamer-model",
      "mock/dreamer-model",
      "--json",
    ]);
    assert.equal(configSetRes.code, 0, configSetRes.stderr);
    const savedSettings = parseWithSchema(EngineSettingsSchema, JSON.parse(configSetRes.stdout));
    assert.equal(savedSettings.maxActiveWorkers, 4);
    assert.equal(savedSettings.models?.dreamer?.modelId, "dreamer-model");

    const createRes = await fixture.runCli([
      "project",
      "create",
      fixture.workspaceDir,
      "--title",
      "Mgmt E2E",
      "--memory",
      "Initial memory constraint A.",
      "--json",
    ]);
    assert.equal(createRes.code, 0, createRes.stderr);
    const projectId = parseWithSchema(CreateProjectResponseSchema, JSON.parse(createRes.stdout))
      .project.id;

    const longPadding = "detailed-architecture-context-segment ".repeat(45);
    const turn1 = await fixture.runCli([
      "send",
      projectId,
      `turn-initial-long ${longPadding}`,
      "--json",
    ]);
    assert.equal(turn1.code, 0, turn1.stderr);

    await waitFor(async () => {
      const entries = await fixture.client.listEntries(projectId, "router", {
        order: "descending",
      });
      return entries.entries.some((e) =>
        JSON.stringify(e).includes("Initial router reply acknowledging baseline setup."),
      );
    }, "turn 1 reply");

    const req1 = fixture.mockOpenAi.requests.find((r) => r.body.model === "test-model");
    assert.ok(req1);
    assert.ok(systemPromptOf(req1).includes("Initial memory constraint A."));
    assert.equal(toolNamesOf(req1).includes("mcp__echomcp__echo_tag"), false);

    const memSetRes = await fixture.runCli([
      "project",
      "memory",
      "set",
      projectId,
      "Updated memory constraint B.",
      "--json",
    ]);
    assert.equal(memSetRes.code, 0, memSetRes.stderr);
    assert.equal(
      parseWithSchema(ProjectMemoryResponseSchema, JSON.parse(memSetRes.stdout)).memory,
      "Updated memory constraint B.",
    );

    const profilesFile = join(fixture.rootDir, "profiles.json");
    await writeFile(
      profilesFile,
      JSON.stringify(
        {
          profiles: [
            {
              id: "smart",
              model: { provider: "mock", modelId: "test-model", thinkingLevel: "low" },
              description: "Smart profile for complex work",
            },
          ],
          notes: "Prefer smart profile for multi-step work.",
        },
        null,
        2,
      ),
      "utf8",
    );
    const profilesSetRes = await fixture.runCli([
      "models",
      "profiles",
      "set",
      "--file",
      profilesFile,
      "--json",
    ]);
    assert.equal(profilesSetRes.code, 0, profilesSetRes.stderr);
    parseWithSchema(ModelProfilesDocumentSchema, JSON.parse(profilesSetRes.stdout));

    const turn2 = await fixture.runCli([
      "send",
      projectId,
      "turn-after-memory-and-profiles",
      "--json",
    ]);
    assert.equal(turn2.code, 0, turn2.stderr);

    await waitFor(async () => {
      const entries = await fixture.client.listEntries(projectId, "router", {
        order: "descending",
      });
      return entries.entries.some((e) =>
        JSON.stringify(e).includes("Updated memory and model profiles visible."),
      );
    }, "turn 2 reply");

    const turn2Req = fixture.mockOpenAi.requests
      .filter((r) => r.body.model === "test-model")
      .at(-1);
    assert.ok(turn2Req);
    const turn2Sys = systemPromptOf(turn2Req);
    assert.ok(turn2Sys.includes("Updated memory constraint B."));
    assert.ok(turn2Sys.includes("Smart profile for complex work"));
    assert.ok(turn2Sys.includes("Prefer smart profile for multi-step work."));

    const mcpAddRes = await fixture.runCli([
      "mcp",
      "add",
      "echomcp",
      "--command",
      process.execPath,
      "--args",
      mcpScriptPath,
      "--exposure",
      "direct",
      "--json",
    ]);
    assert.equal(mcpAddRes.code, 0, mcpAddRes.stderr);
    const mcpState = parseWithSchema(McpStateResponseSchema, JSON.parse(mcpAddRes.stdout));
    assert.equal(mcpState.status.find((s) => s.name === "echomcp")?.status, "connected");
    assert.equal(mcpState.status.find((s) => s.name === "echomcp")?.toolCount, 1);

    const mcpReconnectRes = await fixture.runCli(["mcp", "reconnect", "echomcp", "--json"]);
    assert.equal(mcpReconnectRes.code, 0, mcpReconnectRes.stderr);
    parseWithSchema(ReconnectMcpResponseSchema, JSON.parse(mcpReconnectRes.stdout));

    const turn3 = await fixture.runCli(["send", projectId, "turn-call-stdio-mcp", "--json"]);
    assert.equal(turn3.code, 0, turn3.stderr);

    await waitFor(async () => {
      const entries = await fixture.client.listEntries(projectId, "router", {
        order: "descending",
      });
      parseWithSchema(ListEntriesResponseSchema, entries);
      return entries.entries.some((e) => JSON.stringify(e).includes("STDIO_MCP_OK:pineapple-4c"));
    }, "turn 3 MCP tool call completion");

    const workerMcpTurn = await fixture.runCli([
      "send",
      projectId,
      "worker-call-stdio-mcp",
      "--worker",
      "w1",
      "--json",
    ]);
    assert.equal(workerMcpTurn.code, 0, workerMcpTurn.stderr);
    await waitFor(async () => {
      const entries = await fixture.client.listEntries(projectId, "w1", { order: "descending" });
      return entries.entries.some((e) => JSON.stringify(e).includes("STDIO_MCP_OK:worker-mcp-4c"));
    }, "existing worker w1 MCP tool call completion");

    let usageJson: ProjectUsageResponse | undefined;
    await waitFor(async () => {
      const usageRes = await fixture.runCli(["project", "usage", projectId, "--json"]);
      if (usageRes.code !== 0) return false;
      usageJson = parseWithSchema(ProjectUsageResponseSchema, JSON.parse(usageRes.stdout));
      return (usageJson.usage.models["mock/dreamer-model"]?.totalTokens ?? 0) > 0;
    }, "Dreamer usage to be recorded");
    assert.ok((usageJson?.usage.models["mock/test-model"]?.totalTokens ?? 0) > 0);
    assert.ok((usageJson?.usage.models["mock/dreamer-model"]?.cost.total ?? 0) > 0);

    const exportPath = join(fixture.rootDir, "exported-bundle.json");
    const exportRes = await fixture.runCli(["config", "export", "--file", exportPath]);
    assert.equal(exportRes.code, 0, exportRes.stderr);
    const exportedBundle = parseWithSchema(
      ConfigBundleSchema,
      JSON.parse(await readFile(exportPath, "utf8")),
    );

    const secondHome = await mkdtemp(join(tmpdir(), "eevee-e2e-4c-second-"));
    extraDirs.push(secondHome);
    const secondEngine = spawn(
      process.execPath,
      ["--conditions=eevee-source", CLI_ENTRY, "start", "--foreground", "--port", "0"],
      {
        env: { ...process.env, EEVEE_HOME: secondHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const deadline = Date.now() + 15_000;
      let secondClient: EeveeClient | undefined;
      while (Date.now() < deadline) {
        const state = await readEngineState(join(secondHome, "engine.json")).catch(() => undefined);
        const token = await readAuthToken(join(secondHome, "engine.token")).catch(() => undefined);
        if (state && token) {
          const candidate = new EeveeClient({ baseUrl: state.url, token });
          try {
            if ((await candidate.health()).ok) {
              secondClient = candidate;
              break;
            }
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(secondClient, "second Engine should become healthy");

      const importRes = await fixture.runCli(["config", "import", "--file", exportPath, "--json"], {
        env: { EEVEE_HOME: secondHome },
      });
      assert.equal(importRes.code, 0, importRes.stderr);
      const importedBundle = parseWithSchema(ConfigBundleSchema, JSON.parse(importRes.stdout));
      assert.deepEqual(importedBundle, exportedBundle);
      assert.deepEqual(await secondClient.exportConfig(), exportedBundle);
      assert.equal(
        (await secondClient.getMcpState()).status.find((s) => s.name === "echomcp")?.status,
        "connected",
      );
    } finally {
      await stopChildProcess(secondEngine).catch(() => undefined);
    }

    const updateRes = await fixture.runCli([
      "project",
      "update",
      projectId,
      "--title",
      "Renamed E2E",
      "--json",
    ]);
    assert.equal(updateRes.code, 0, updateRes.stderr);
    assert.equal(
      parseWithSchema(GetProjectResponseSchema, JSON.parse(updateRes.stdout)).project.title,
      "Renamed E2E",
    );

    const projectDataDir = join(fixture.homeDir, "projects", projectId);
    assert.equal(existsSync(projectDataDir), true);

    const removeRes = await fixture.runCli(["project", "remove", projectId, "--json"]);
    assert.equal(removeRes.code, 0, removeRes.stderr);
    const removed = parseWithSchema(DeleteProjectResponseSchema, JSON.parse(removeRes.stdout));
    assert.equal(removed.ok, true);
    assert.equal(removed.id, projectId);
    assert.equal(existsSync(projectDataDir), false);
    assert.equal(await readFile(keepFile, "utf8"), "must remain untouched");
  } finally {
    await fixture.cleanup();
    for (const dir of extraDirs) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
