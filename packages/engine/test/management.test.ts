import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  createProvider,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  LATEST_PROTOCOL_VERSION,
  type Tool as McpTool,
  type McpTransport,
  PipeTransport,
} from "@earendil-works/pi-mcp";
import type { McpServerEntry } from "@eevee/agent";
import { AuthStorage } from "@eevee/agent/models";
import { MemoryMetaDoc } from "@eevee/memory";
import {
  ConfigBundleSchema,
  DeleteProjectResponseSchema,
  EeveeApiError,
  EeveeClient,
  EngineSettingsSchema,
  GetProjectResponseSchema,
  ListModelsResponseSchema,
  ListProvidersResponseSchema,
  type LoginStreamEvent,
  McpStateResponseSchema,
  ModelProfilesDocumentSchema,
  OkResponseSchema,
  ProblemSchema,
  ProjectMemoryResponseSchema,
  ProjectUsageResponseSchema,
  parseWithSchema,
  ReconnectMcpResponseSchema,
  RefreshModelsResponseSchema,
  StartLoginResponseSchema,
} from "@eevee/protocol";
import {
  KV_SETTINGS,
  KV_SKILLS_POLICY,
  readEngineSettings,
  readGlobalSkillsPolicy,
} from "../src/engine-config.ts";
import { EngineStore, startForegroundEngine } from "../src/index.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "eevee-engine-4c-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

type PipeLink = {
  readonly onStdout: (bytes: Uint8Array) => void;
  readonly exited: Promise<void>;
  readonly finish: () => void;
  buffer: string;
  closed: boolean;
};

class FakeMcpServer {
  tools: McpTool[];
  failInitialize = false;
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private link?: PipeLink;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(tools: McpTool[] = []) {
    this.tools = [...tools];
  }

  createTransport(): McpTransport {
    return new PipeTransport({
      closeTimeoutMs: 20,
      open: async (handlers) => {
        const link = this.attach(handlers.onStdout);
        return {
          write: (data) => this.receive(link, data),
          closeStdin: () => this.finish(link),
          close: () => this.finish(link),
          exited: link.exited,
        };
      },
    });
  }

  private attach(onStdout: (bytes: Uint8Array) => void): PipeLink {
    let finish = () => {};
    const exited = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const link: PipeLink = { onStdout, exited, finish, buffer: "", closed: false };
    this.link = link;
    return link;
  }

  private finish(link: PipeLink): void {
    if (link.closed) return;
    link.closed = true;
    if (this.link === link) this.link = undefined;
    queueMicrotask(link.finish);
  }

  private send(link: PipeLink, message: Record<string, unknown>): void {
    if (link.closed) return;
    link.onStdout(this.encoder.encode(`${JSON.stringify(message)}\n`));
  }

  private receive(link: PipeLink, data: Uint8Array | string): void {
    if (link.closed) return;
    link.buffer += typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    for (;;) {
      const newline = link.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = link.buffer.slice(0, newline).trim();
      link.buffer = link.buffer.slice(newline + 1);
      if (line === "") continue;
      this.handleMessage(link, JSON.parse(line) as Record<string, unknown>);
    }
  }

  private handleMessage(link: PipeLink, message: Record<string, unknown>): void {
    if (!("id" in message)) return;
    const id = message.id as string | number;
    const method = message.method;
    if (method === "initialize") {
      if (this.failInitialize) {
        this.send(link, {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "initialize failed" },
        });
        return;
      }
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "tools/list") {
      this.send(link, { jsonrpc: "2.0", id, result: { tools: this.tools } });
      return;
    }
    if (method === "tools/call") {
      const req = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = req.name ?? "";
      const args = req.arguments ?? {};
      this.calls.push({ name, args });
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `mcp:${name}:${JSON.stringify(args)}` }] },
      });
      return;
    }
    this.send(link, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${String(method)}` },
    });
  }
}

function mcpTool(name: string, description: string): McpTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  };
}

function createOAuthTestProvider(id: string, faux: ReturnType<typeof fauxProvider>): Provider {
  return createProvider({
    id,
    name: "OAuth Test Provider",
    baseUrl: "https://oauth-test.example.com",
    models: [
      {
        id: "oauth-model-1",
        name: "OAuth Model 1",
        api: "openai-completions",
        provider: id,
        baseUrl: "https://oauth-test.example.com",
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 32_000,
        maxTokens: 4_096,
      },
    ],
    api: faux.provider,
    auth: {
      apiKey: {
        name: "OAuth Test API Key",
        login: async (interaction) => {
          const key = await interaction.prompt({
            type: "secret",
            message: "Paste API key",
          });
          return { type: "api_key", key };
        },
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored key" } : undefined,
      },
      oauth: {
        name: "Test OAuth",
        loginLabel: "Sign in with Test OAuth",
        login: async (interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://oauth-test.example.com/authorize",
            instructions: "Open URL and paste code",
          });
          const mode = await interaction.prompt({
            type: "select",
            message: "Select account tier",
            options: [
              { id: "pro", label: "Pro" },
              { id: "team", label: "Team" },
            ],
          });
          const code = await interaction.prompt({
            type: "manual_code",
            message: "Enter authorization code",
          });
          return {
            type: "oauth",
            access: `access-${mode}-${code}`,
            refresh: `refresh-${code}`,
            expires: Date.now() + 3_600_000,
          };
        },
        refresh: async (credential) => ({
          ...credential,
          expires: Date.now() + 3_600_000,
        }),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  });
}

test("providers list, API key login/logout, and interactive OAuth & cancel flows over SSE", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const credentials = new AuthStorage(join(home, "auth.json"));
    const models = createModels({ credentials });
    models.setProvider(createOAuthTestProvider("oauth-test", faux));
    let refreshedOnce = false;
    models.setProvider(
      createProvider({
        id: "refreshable",
        name: "Refreshable",
        models: [],
        fetchModels: async () => {
          refreshedOnce = true;
          return [
            {
              id: "dynamic-1",
              name: "Dynamic 1",
              api: "openai-completions",
              provider: "refreshable",
              baseUrl: "https://refreshable.example.com",
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ];
        },
        api: faux.provider,
        auth: {
          apiKey: {
            name: "Refreshable Key",
            resolve: async ({ credential }) =>
              credential?.key
                ? { auth: { apiKey: credential.key }, source: "auth.json" }
                : undefined,
          },
        },
      }),
    );

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      credentials,
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const authHeader = { Authorization: `Bearer ${foreground.token}` };

      // Enforce 401 and 405 on management routes
      const unauthProviders = await fetch(`${foreground.url}/providers`);
      assert.equal(unauthProviders.status, 401);
      const wrongMethodProviders = await fetch(`${foreground.url}/providers`, {
        method: "PUT",
        headers: authHeader,
      });
      assert.equal(wrongMethodProviders.status, 405);
      assert.equal(wrongMethodProviders.headers.get("allow"), "GET, POST");
      parseWithSchema(ProblemSchema, await wrongMethodProviders.json());

      // List providers initially unconfigured
      const initialProviders = await client.listProviders();
      parseWithSchema(ListProvidersResponseSchema, initialProviders);
      const oauthEntry = initialProviders.providers.find((p) => p.id === "oauth-test");
      assert.ok(oauthEntry);
      assert.equal(oauthEntry.configured, false);
      assert.equal(oauthEntry.authMethods.oauth, true);
      assert.equal(oauthEntry.authMethods.apiKeyLogin, true);
      assert.equal(oauthEntry.modelCount, 1);

      // Available models filter excludes unconfigured providers
      const availBefore = await client.listModels({ available: true });
      parseWithSchema(ListModelsResponseSchema, availBefore);
      assert.equal(availBefore.models.length, 0);

      // Direct API key login -> configured & model available
      parseWithSchema(
        OkResponseSchema,
        await client.setProviderApiKey("refreshable", { key: "sk-refresh" }),
      );
      const refreshRes = await client.refreshModels({ providers: ["refreshable"], force: true });
      parseWithSchema(RefreshModelsResponseSchema, refreshRes);
      assert.equal(refreshedOnce, true);
      assert.deepEqual(refreshRes.errors, {});

      const listedDynamic = await client.listModels({ provider: "refreshable", available: true });
      assert.equal(listedDynamic.models.length, 1);
      assert.equal(listedDynamic.models[0]?.id, "dynamic-1");

      // Interactive OAuth login via SSE + /input
      const session = await client.startProviderLogin("oauth-test", { type: "oauth" });
      parseWithSchema(StartLoginResponseSchema, session);

      const seenEvents: LoginStreamEvent[] = [];
      for await (const evt of client.streamLoginSession("oauth-test", session.sessionId)) {
        seenEvents.push(evt);
        if (evt.type === "prompt") {
          if (evt.prompt.type === "select") {
            await client.submitLoginInput("oauth-test", session.sessionId, {
              promptId: evt.prompt.promptId,
              value: "pro",
            });
          } else {
            await client.submitLoginInput("oauth-test", session.sessionId, {
              promptId: evt.prompt.promptId,
              value: "code-42",
            });
          }
        }
      }
      assert.deepEqual(
        seenEvents.map((e) => e.type),
        ["auth", "prompt", "prompt", "complete"],
      );

      const afterOAuth = await client.listProviders();
      const oauthAfter = afterOAuth.providers.find((p) => p.id === "oauth-test");
      assert.equal(oauthAfter?.configured, true);
      assert.equal(oauthAfter?.authType, "oauth");
      const storedCred = await credentials.read("oauth-test");
      assert.equal(storedCred?.type, "oauth");
      if (storedCred?.type === "oauth") {
        assert.equal(storedCred.access, "access-pro-code-42");
      }

      // Interactive API key login + cancel flow
      const cancelSession = await client.startProviderLogin("oauth-test", { type: "api_key" });
      const cancelEvents: LoginStreamEvent[] = [];
      for await (const evt of client.streamLoginSession("oauth-test", cancelSession.sessionId)) {
        cancelEvents.push(evt);
        if (evt.type === "prompt") {
          await client.cancelLoginSession("oauth-test", cancelSession.sessionId);
        }
      }
      const lastCancelEvent = cancelEvents.at(-1);
      assert.equal(lastCancelEvent?.type, "error");
      if (lastCancelEvent?.type === "error") {
        assert.equal(lastCancelEvent.error.code, "login_cancelled");
      }

      // Logout removes stored credential
      parseWithSchema(OkResponseSchema, await client.logoutProvider("oauth-test"));
      const afterLogout = await client.listProviders();
      assert.equal(afterLogout.providers.find((p) => p.id === "oauth-test")?.configured, false);
    } finally {
      await foreground.close();
    }
  });
});

test("settings, model profiles, project update, and memory take effect live on the next LLM request", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "ws1");
    const ws2 = join(dir, "ws2");
    await mkdir(ws1, { recursive: true });
    await mkdir(ws2, { recursive: true });

    const faux = fauxProvider({ models: [{ id: MODEL_ID }, { id: "faux-2" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const seenPrompts: string[] = [];
    const seenModels: string[] = [];
    const brain: FauxResponseFactory = (context, _opts, _state, model) => {
      seenPrompts.push(getCurrentSystemPrompt(context.messages));
      seenModels.push(model.id);
      return fauxAssistantMessage("ack");
    };
    faux.setResponses(Array.from({ length: 10 }, () => brain));

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
      const created = await client.createProject({
        workspaces: [ws1],
        title: "Alpha",
        memory: "Memory v1",
      });
      const projectId = created.project.id;

      const sendAndWait = async (text: string) => {
        const sent = await client.sendMessage(projectId, "router", { text });
        const handle = await foreground.engine.openProject(projectId);
        const sub = await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT);
        await sub?.wait(BACKGROUND_CONTEXT);
      };

      await sendAndWait("turn 1");
      assert.ok(seenPrompts[0]?.includes("Memory v1"));
      assert.ok(seenPrompts[0]?.includes("Project: Alpha"));
      assert.equal(seenPrompts[0]?.includes("fast-worker"), false);

      // Update project memory, model profiles, project metadata, and global settings while open!
      const memUpdate = await client.putProjectMemory(projectId, { memory: "Memory v2 strict" });
      parseWithSchema(ProjectMemoryResponseSchema, memUpdate);
      assert.equal(memUpdate.memory, "Memory v2 strict");

      const profilesUpdate = await client.putModelProfiles({
        profiles: [
          {
            id: "fast-worker",
            model: { provider: faux.provider.id, modelId: "faux-2" },
            description: "Quick edits",
          },
        ],
        notes: "Prefer fast-worker for simple tasks.",
      });
      parseWithSchema(ModelProfilesDocumentSchema, profilesUpdate);

      const updatedProj = await client.updateProject(projectId, {
        title: "Beta",
        workspaces: [ws2],
      });
      parseWithSchema(GetProjectResponseSchema, updatedProj);
      assert.equal(updatedProj.project.title, "Beta");

      const settingsUpdate = await client.patchSettings({
        maxActiveWorkers: 5,
        models: {
          router: { provider: faux.provider.id, modelId: "faux-2" },
        },
      });
      parseWithSchema(EngineSettingsSchema, settingsUpdate);

      await sendAndWait("turn 2");
      const secondPrompt = seenPrompts[1] ?? "";
      assert.ok(secondPrompt.includes("Memory v2 strict"));
      assert.ok(secondPrompt.includes("Project: Beta"));
      assert.ok(secondPrompt.includes("fast-worker"));
      assert.ok(secondPrompt.includes("Prefer fast-worker for simple tasks."));
      assert.equal(seenModels[1], "faux-2");

      // Clear memory -> memory omitted
      const cleared = await client.putProjectMemory(projectId, { memory: null });
      assert.equal(cleared.memory, null);
      await sendAndWait("turn 3");
      assert.equal(seenPrompts[2]?.includes("Memory v2 strict"), false);
    } finally {
      await foreground.close();
    }
  });
});

test("tool settings merge with project overrides, propagate live, and persist across SQLite reopen", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let foreground = await startForegroundEngine({
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
      const created = await client.createProject({
        workspaces: [ws],
        title: "Tool policy",
        tools: { router: { ls: true }, codemode: { mode: "on" } },
      });
      const projectId = created.project.id;
      assert.deepEqual(created.project.tools, {
        router: { ls: true },
        codemode: { mode: "on" },
      });

      await client.patchSettings({
        tools: {
          router: { ls: false, grep: false },
          worker: { bash: false, powershell: true },
          codemode: { mode: "off", inlineBudget: 4_321 },
        },
      });
      const handle = await foreground.engine.openProject(projectId);
      const initial = await handle.root.agent(BACKGROUND_CONTEXT);
      const initialNames = initial.tools.map((tool) => tool.name);
      assert.ok(initialNames.includes("ls"));
      assert.equal(initialNames.includes("grep"), false);
      assert.ok(initialNames.includes("codemode"));

      const overridden = await client.updateProject(projectId, {
        tools: {
          router: { read: false, ls: false },
          worker: { grep: true },
          codemode: { mode: "only" },
        },
      });
      assert.deepEqual(overridden.project.tools, {
        router: { read: false, ls: false },
        worker: { grep: true },
        codemode: { mode: "only" },
      });
      const only = await handle.root.agent(BACKGROUND_CONTEXT);
      assert.deepEqual(
        only.tools.map((tool) => tool.name),
        ["codemode"],
      );
      assert.equal(
        only.callable.some((tool) => tool.name === "read"),
        false,
      );
      assert.equal(
        only.callable.some((tool) => tool.name === "ls"),
        false,
      );
      assert.equal(
        only.callable.some((tool) => tool.name === "grep"),
        false,
      );

      const globallyUpdated = await client.patchSettings({
        tools: { router: { grep: true }, codemode: { mode: "on" } },
      });
      assert.deepEqual(globallyUpdated.tools, {
        router: { ls: false, grep: true },
        worker: { bash: false, powershell: true },
        codemode: { mode: "on", inlineBudget: 4_321 },
      });
      const stillOnly = await handle.root.agent(BACKGROUND_CONTEXT);
      assert.deepEqual(
        stillOnly.tools.map((tool) => tool.name),
        ["codemode"],
      );
      assert.ok(stillOnly.callable.some((tool) => tool.name === "grep"));

      const cleared = await client.updateProject(projectId, { tools: null });
      assert.equal(cleared.project.tools, undefined);
      const inherited = await handle.root.agent(BACKGROUND_CONTEXT);
      const inheritedNames = inherited.tools.map((tool) => tool.name);
      assert.ok(inheritedNames.includes("read"));
      assert.ok(inheritedNames.includes("grep"));
      assert.ok(inheritedNames.includes("codemode"));
      assert.equal(inheritedNames.includes("ls"), false);

      const persistedTools = {
        router: { read: false },
        worker: { powershell: true, grep: true },
        codemode: { mode: "off" as const, inlineBudget: 123 },
      };
      await client.updateProject(projectId, { tools: persistedTools });
      const exported = await client.exportConfig();
      assert.deepEqual(exported.settings.tools, globallyUpdated.tools);
    } finally {
      await foreground.close();
    }

    foreground = await startForegroundEngine({
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
      const reopenedProject = (await client.listProjects()).projects.find(
        (project) => project.title === "Tool policy",
      );
      assert.deepEqual(reopenedProject?.tools, {
        router: { read: false },
        worker: { powershell: true, grep: true },
        codemode: { mode: "off", inlineBudget: 123 },
      });
      assert.deepEqual((await client.getSettings()).tools, {
        router: { ls: false, grep: true },
        worker: { bash: false, powershell: true },
        codemode: { mode: "on", inlineBudget: 4_321 },
      });
      assert.ok(reopenedProject);
      const handle = await foreground.engine.openProject(reopenedProject.id);
      const reopened = await handle.root.agent(BACKGROUND_CONTEXT);
      const reopenedNames = reopened.tools.map((tool) => tool.name);
      assert.equal(reopenedNames.includes("read"), false);
      assert.equal(reopenedNames.includes("ls"), false);
      assert.ok(reopenedNames.includes("grep"));
      assert.equal(reopenedNames.includes("codemode"), false);
    } finally {
      await foreground.close();
    }
  });
});

test("shared McpHub propagates live MCP reloads to multiple open projects and supports reconnect", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "ws1");
    const ws2 = join(dir, "ws2");
    await mkdir(ws1, { recursive: true });
    await mkdir(ws2, { recursive: true });

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const alphaServer = new FakeMcpServer([mcpTool("ping", "Ping tool")]);
    const flakyServer = new FakeMcpServer([mcpTool("lookup", "Lookup tool")]);
    flakyServer.failInitialize = true;

    const observedToolsByProject: string[][] = [];
    const brain: FauxResponseFactory = (context) => {
      const last = lastMessage(context);
      const toolNames = getCurrentTools(context.messages).map((t) => t.name);
      observedToolsByProject.push(toolNames);
      if (last?.role === "user" && messageText(last).includes("call-alpha")) {
        return fauxAssistantMessage([fauxToolCall("mcp__alpha__ping", { value: "hello" })], {
          stopReason: "toolUse",
        });
      }
      if (last?.role === "toolResult" && last.toolName === "mcp__alpha__ping") {
        return fauxAssistantMessage(`got:${messageText(last)}`);
      }
      return fauxAssistantMessage("ok");
    };
    faux.setResponses(Array.from({ length: 20 }, () => brain));

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "alpha") return alphaServer.createTransport();
        if (entry.name === "flaky") return flakyServer.createTransport();
        throw new Error(`No fake server for ${entry.name}`);
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const p1 = (await client.createProject({ workspaces: [ws1], title: "P1" })).project.id;
      const p2 = (await client.createProject({ workspaces: [ws2], title: "P2" })).project.id;

      const sendAndWait = async (projectId: string, text: string) => {
        const handle = await foreground.engine.openProject(projectId);
        const sent = await client.sendMessage(projectId, "router", { text });
        const sub = await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT);
        await sub?.wait(BACKGROUND_CONTEXT);
      };

      // Open both projects BEFORE adding MCP servers
      await sendAndWait(p1, "warmup-1");
      await sendAndWait(p2, "warmup-2");
      assert.equal(observedToolsByProject[0]?.includes("mcp__alpha__ping"), false);
      assert.equal(observedToolsByProject[1]?.includes("mcp__alpha__ping"), false);

      // Invalid namespace collision rejected with 400 BEFORE mutating kv
      await assert.rejects(
        client.putMcpConfig({
          servers: {
            "foo-bar": { command: "one" },
            foo_bar: { command: "two" },
          },
        }),
        (err: unknown) => err instanceof EeveeApiError && err.status === 400,
      );
      assert.deepEqual((await client.getMcpState()).servers, {});

      // Upsert alpha (direct exposure) -> propagates immediately to BOTH already-open projects
      const addedAlpha = await client.upsertMcpServer("alpha", {
        config: { command: "alpha-cmd", exposure: "direct" },
      });
      parseWithSchema(McpStateResponseSchema, addedAlpha);
      assert.equal(addedAlpha.status[0]?.status, "connected");
      assert.equal(addedAlpha.status[0]?.toolCount, 1);

      await sendAndWait(p1, "call-alpha-p1");
      await sendAndWait(p2, "call-alpha-p2");
      assert.equal(alphaServer.calls.length, 2);

      // Add flaky (initially fails) -> reconnect after fixing -> becomes connected
      await client.upsertMcpServer("flaky", {
        config: { command: "flaky-cmd", exposure: "direct" },
      });
      assert.equal(
        (await client.getMcpState()).status.find((s) => s.name === "flaky")?.status,
        "failed",
      );

      // Unknown / disabled reconnect error codes
      await assert.rejects(
        client.reconnectMcp({ server: "unknown-srv" }),
        (err: unknown) => err instanceof EeveeApiError && err.status === 404,
      );

      flakyServer.failInitialize = false;
      const reconnected = await client.reconnectMcp({ server: "flaky" });
      parseWithSchema(ReconnectMcpResponseSchema, reconnected);
      assert.equal(reconnected.status.find((s) => s.name === "flaky")?.status, "connected");

      // Delete alpha -> tool disappears from open projects
      await client.deleteMcpServer("alpha");
      await sendAndWait(p1, "after-delete");
      assert.equal(observedToolsByProject.at(-1)?.includes("mcp__alpha__ping"), false);
    } finally {
      await foreground.close();
    }
  });
});

test("project idle hibernation skips active/streaming projects, closes idle ones, and transparently reopens", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let runStarted!: () => void;
    const runStartedPromise = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    faux.setResponses([
      () => fauxAssistantMessage("hello"),
      async () => {
        runStarted();
        await runGate;
        return fauxAssistantMessage("finished");
      },
    ]);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      idleHibernateMs: 5_000,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "Hibernate" }))
        .project.id;

      // Open project via message
      const handle = await foreground.engine.openProject(projectId);
      const sent = await client.sendMessage(projectId, "router", { text: "first" });
      const sub = await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT);
      await sub?.wait(BACKGROUND_CONTEXT);
      assert.equal(foreground.engine.isProjectOpen(projectId), true);

      // Active SSE stream blocks hibernation even when time advances past idleHibernateMs
      const streamAbort = new AbortController();
      let gotSnapshot = false;
      const streamLoop = (async () => {
        for await (const evt of client.streamConversation(projectId, "router", {
          signal: streamAbort.signal,
        })) {
          if (evt.type === "snapshot") {
            gotSnapshot = true;
            break;
          }
        }
      })();
      await waitFor(() => gotSnapshot, "initial snapshot on active stream");
      const boardAbort = new AbortController();
      let gotBoard = false;
      const boardLoop = (async () => {
        for await (const evt of client.streamBoard(projectId, { signal: boardAbort.signal })) {
          if (evt.type === "board") gotBoard = true;
        }
      })();
      await waitFor(() => gotBoard, "initial board SSE event");

      assert.deepEqual(await foreground.engine.hibernateIdleProjects(Date.now() + 60_000), []);
      assert.equal(foreground.engine.isProjectOpen(projectId), true);

      // Active run blocks hibernation too
      streamAbort.abort();
      boardAbort.abort();
      await Promise.all([streamLoop, boardLoop]);

      const slowSend = await client.sendMessage(projectId, "router", { text: "slow run" });
      await runStartedPromise;
      assert.deepEqual(await foreground.engine.hibernateIdleProjects(Date.now() + 60_000), []);
      assert.equal(foreground.engine.isProjectOpen(projectId), true);
      releaseRun();
      const slowSub = await handle.harness.submission(
        slowSend.submissionId as never,
        BACKGROUND_CONTEXT,
      );
      await slowSub?.wait(BACKGROUND_CONTEXT);

      // Once idle, manual hibernation succeeds
      await waitFor(
        async () =>
          (await foreground.engine.hibernateIdleProjects(Date.now() + 60_000)).length === 1,
        "hibernation after run settled",
      );
      assert.equal(foreground.engine.isProjectOpen(projectId), false);

      // Next request transparently reopens the project with persisted history
      const entries = await client.listEntries(projectId, "router");
      assert.equal(foreground.engine.isProjectOpen(projectId), true);
      assert.ok(entries.entries.some((e) => JSON.stringify(e).includes("hello")));

      // Setting a short idleHibernateMs triggers the periodic unref'd sweeper automatically
      await client.patchSettings({ idleHibernateMs: 50 });
      await waitFor(
        () => !foreground.engine.isProjectOpen(projectId),
        "automatic periodic idle hibernation",
      );
    } finally {
      releaseRun();
      await foreground.close();
    }
  });
});

test("project deletion closes open handle, removes projects/<id>/, and leaves workspace files untouched", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "workspace");
    await mkdir(ws, { recursive: true });
    const keepFile = join(ws, "important.txt");
    await writeFile(keepFile, "user code stays untouched", "utf8");

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([() => fauxAssistantMessage("saved")]);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "Temp" })).project
        .id;
      const handle = await foreground.engine.openProject(projectId);
      const sent = await client.sendMessage(projectId, "router", { text: "hi" });
      const sub = await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT);
      await sub?.wait(BACKGROUND_CONTEXT);

      const projectDataDir = join(home, "projects", projectId);
      assert.equal(existsSync(projectDataDir), true);

      const deleted = await client.deleteProject(projectId);
      parseWithSchema(DeleteProjectResponseSchema, deleted);
      assert.equal(deleted.ok, true);
      assert.equal(deleted.id, projectId);
      assert.equal(foreground.engine.isProjectOpen(projectId), false);
      assert.equal(existsSync(projectDataDir), false);
      assert.equal(await readFile(keepFile, "utf8"), "user code stays untouched");

      await assert.rejects(
        client.getProject(projectId),
        (err: unknown) => err instanceof EeveeApiError && err.status === 404,
      );
      await assert.rejects(
        client.deleteProject(projectId),
        (err: unknown) => err instanceof EeveeApiError && err.status === 404,
      );
    } finally {
      await foreground.close();
    }
  });
});

test("config export omits auth.json secrets, rejects invalid imports upfront, and round-trips into a fresh EEVEE_HOME", async () => {
  await withTempDir(async (dir) => {
    const homeA = join(dir, "home-a");
    const homeB = join(dir, "home-b");
    await mkdir(homeA, { recursive: true });
    await mkdir(homeB, { recursive: true });

    await writeFile(
      join(homeA, "models.json"),
      JSON.stringify(
        {
          providers: {
            custom: {
              baseUrl: "http://127.0.0.1:9001/v1",
              api: "openai-completions",
              models: [{ id: "custom-1" }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(homeA, "auth.json"),
      JSON.stringify({ custom: { type: "api_key", key: "SUPER_SECRET_DO_NOT_EXPORT" } }),
      "utf8",
    );

    const server = new FakeMcpServer([mcpTool("ping", "Ping")]);
    const mcpFactory = (entry: McpServerEntry) => {
      if (entry.name === "tools") return server.createTransport();
      throw new Error(`Unexpected server ${entry.name}`);
    };

    const engineA = await startForegroundEngine({
      dataDir: homeA,
      port: 0,
      createMcpTransport: mcpFactory,
    });

    let exportedBundle: unknown;
    try {
      const clientA = new EeveeClient({ baseUrl: engineA.url, token: engineA.token });
      await clientA.putSettings({
        maxActiveWorkers: 6,
        backgroundAfterMs: 12_000,
        routerContextTokens: 90_000,
        idleHibernateMs: 45_000,
        models: { router: { provider: "custom", modelId: "custom-1" } },
        tools: {
          router: { ls: false, grep: true },
          worker: { bash: false, powershell: true },
          codemode: { mode: "only", inlineBudget: 2_500 },
        },
      });
      await clientA.putModelProfiles({
        profiles: [
          {
            id: "coder",
            model: { provider: "custom", modelId: "custom-1", thinkingLevel: "medium" },
            description: "Primary coder",
          },
        ],
        notes: "Use coder profile.",
      });
      await clientA.putMcpConfig({
        servers: {
          tools: { command: "tools-mcp", exposure: "direct" },
        },
      });

      const bundle = await clientA.exportConfig();
      parseWithSchema(ConfigBundleSchema, bundle);
      assert.equal(JSON.stringify(bundle).includes("SUPER_SECRET_DO_NOT_EXPORT"), false);
      exportedBundle = bundle;
    } finally {
      await engineA.close();
    }

    const engineB = await startForegroundEngine({
      dataDir: homeB,
      port: 0,
      createMcpTransport: mcpFactory,
    });
    try {
      const clientB = new EeveeClient({ baseUrl: engineB.url, token: engineB.token });

      // Invalid import (bad models.json provider api) fails with 400 and leaves Engine B clean
      await assert.rejects(
        clientB.importConfig({
          version: 1,
          settings: { maxActiveWorkers: 99 },
          modelProfiles: { profiles: [] },
          mcpServers: {},
          modelsConfig: {
            providers: {
              broken: {
                baseUrl: "http://127.0.0.1:1/v1",
                api: "unknown-api",
                models: [{ id: "x" }],
              },
            },
          },
        }),
        (err: unknown) => err instanceof EeveeApiError && err.status === 400,
      );
      assert.deepEqual(await clientB.getSettings(), {});

      // Valid import reproduces identical config bundle
      const parsedBundle = parseWithSchema(ConfigBundleSchema, exportedBundle);
      const imported = await clientB.importConfig(parsedBundle);
      assert.deepEqual(imported, parsedBundle);
      assert.deepEqual(await clientB.exportConfig(), parsedBundle);
      assert.ok(
        engineB.engine.modelRuntime.resolveModel({ provider: "custom", modelId: "custom-1" }),
      );
      assert.equal(
        (await clientB.getMcpState()).status.find((s) => s.name === "tools")?.status,
        "connected",
      );
      if (process.platform !== "win32") {
        assert.equal((await stat(join(homeB, "models.json"))).mode & 0o777, 0o600);
      }
    } finally {
      await engineB.close();
    }
  });
});

test("EngineStore.transaction commits nested savepoints and rolls back cleanly on error", async () => {
  await withTempDir(async (dir) => {
    const store = EngineStore.open(join(dir, "engine.db"));
    try {
      store.setKv("k1", { v: 1 });

      assert.throws(() => {
        store.transaction(() => {
          store.setKv("k1", { v: 2 });
          store.setKv("k2", { v: 2 });
          throw new Error("boom inside tx");
        });
      }, /boom inside tx/);

      assert.deepEqual(store.getKv("k1"), { v: 1 });
      assert.equal(store.getKv("k2"), undefined);

      store.transaction(() => {
        store.setKv("k1", { v: 3 });
        assert.throws(() => {
          store.transaction(() => {
            store.setKv("k1", { v: 4 });
            throw new Error("inner fail");
          });
        }, /inner fail/);
        store.setKv("k2", { v: 3 });
      });

      assert.deepEqual(store.getKv("k1"), { v: 3 });
      assert.deepEqual(store.getKv("k2"), { v: 3 });
    } finally {
      store.close();
    }
  });
});

test("project usage sums conversation pi.usage and Dreamer MemoryMetaDoc.usage", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses([() => fauxAssistantMessage("hello with recorded usage tokens")]);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "Usage" })).project
        .id;
      const handle = await foreground.engine.openProject(projectId);
      const sent = await client.sendMessage(projectId, "router", { text: "count usage" });
      const sub = await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT);
      await sub?.wait(BACKGROUND_CONTEXT);

      // Record Dreamer usage directly in MemoryMetaDoc to verify combined aggregation
      await handle.harness.commit(async (tx) => {
        const meta = await tx.doc(MemoryMetaDoc, handle.root.id);
        meta.usage["dreamer-provider/dreamer-mini"] = {
          input: 500,
          output: 80,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 580,
          cost: { input: 0.05, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.09 },
        };
      }, BACKGROUND_CONTEXT);

      const usageRes = await client.getProjectUsage(projectId);
      parseWithSchema(ProjectUsageResponseSchema, usageRes);
      assert.equal(usageRes.projectId, projectId);
      const routerKey = `${faux.provider.id}/${MODEL_ID}`;
      assert.ok((usageRes.usage.models[routerKey]?.totalTokens ?? 0) > 0);
      assert.equal(usageRes.usage.models["dreamer-provider/dreamer-mini"]?.totalTokens, 580);
      assert.equal(usageRes.usage.models["dreamer-provider/dreamer-mini"]?.cost.total, 0.09);
    } finally {
      await foreground.close();
    }
  });
});

test("updateProject workspaces reconfigures an already-open project cwd and AGENTS.md discovery", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "ws1");
    const ws2 = join(dir, "ws2");
    await mkdir(ws1, { recursive: true });
    await mkdir(ws2, { recursive: true });
    await writeFile(join(ws1, "AGENTS.md"), "WS1_ONLY_CONTEXT_MARKER\n", "utf8");
    await writeFile(join(ws2, "AGENTS.md"), "WS2_LIVE_CONTEXT_MARKER\n", "utf8");

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const seenPrompts: string[] = [];
    const brain: FauxResponseFactory = (context) => {
      seenPrompts.push(getCurrentSystemPrompt(context.messages));
      return fauxAssistantMessage("ack");
    };
    faux.setResponses([brain, brain]);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws1], title: "LiveWS" })).project
        .id;
      const handle = await foreground.engine.openProject(projectId);

      const first = await client.sendMessage(projectId, "router", { text: "turn 1" });
      await (
        await handle.harness.submission(first.submissionId as never, BACKGROUND_CONTEXT)
      )?.wait(BACKGROUND_CONTEXT);

      assert.equal((await handle.root.agent(BACKGROUND_CONTEXT)).cwd, ws1);
      assert.ok(seenPrompts[0]?.includes("WS1_ONLY_CONTEXT_MARKER"));
      assert.equal(seenPrompts[0]?.includes("WS2_LIVE_CONTEXT_MARKER"), false);

      await client.updateProject(projectId, { workspaces: [ws2] });
      assert.equal(foreground.engine.isProjectOpen(projectId), true);
      assert.equal((await handle.root.agent(BACKGROUND_CONTEXT)).cwd, ws2);

      const second = await client.sendMessage(projectId, "router", { text: "turn 2" });
      await (
        await handle.harness.submission(second.submissionId as never, BACKGROUND_CONTEXT)
      )?.wait(BACKGROUND_CONTEXT);

      assert.ok(seenPrompts[1]?.includes("WS2_LIVE_CONTEXT_MARKER"));
      assert.equal(seenPrompts[1]?.includes("WS1_ONLY_CONTEXT_MARKER"), false);
    } finally {
      await foreground.close();
    }
  });
});

test("EngineStore PRAGMA user_version migrations are idempotent, upgrade legacy DBs, and surface corrupt JSON/config", async () => {
  await withTempDir(async (dir) => {
    const freshDb = join(dir, "fresh.sqlite");
    const store1 = EngineStore.open(freshDb);
    const created = store1.createProject({ workspaces: [dir], title: "Fresh" });
    store1.close();

    const readUserVersion = (dbPath: string): number | undefined => {
      const db = new DatabaseSync(dbPath);
      try {
        return (
          db.prepare("PRAGMA user_version").get() as { readonly user_version: number } | undefined
        )?.user_version;
      } finally {
        db.close();
      }
    };

    assert.equal(readUserVersion(freshDb), 1);

    const store1Reopened = EngineStore.open(freshDb);
    assert.equal(store1Reopened.getProject(created.id)?.title, "Fresh");
    store1Reopened.close();

    assert.equal(readUserVersion(freshDb), 1);

    // Pre-versioned DB (user_version = 0) missing newer project columns
    const legacyMissingColsDb = join(dir, "legacy-missing.sqlite");
    const rawMissing = new DatabaseSync(legacyMissingColsDb);
    try {
      rawMissing.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspaces_json TEXT NOT NULL,
          memory TEXT,
          models_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      rawMissing
        .prepare(
          "INSERT INTO projects (id, title, workspaces_json, memory, models_json, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, 1, 1)",
        )
        .run("legacy-1", "Legacy One", JSON.stringify([dir]));
    } finally {
      rawMissing.close();
    }

    const migratedMissing = EngineStore.open(legacyMissingColsDb);
    try {
      assert.equal(migratedMissing.getProject("legacy-1")?.title, "Legacy One");
      assert.equal(migratedMissing.setProjectSkillsPolicy("legacy-1", { foo: "disabled" }), true);
      assert.deepEqual(migratedMissing.getProjectSkillsPolicy("legacy-1"), { foo: "disabled" });
    } finally {
      migratedMissing.close();
    }

    assert.equal(readUserVersion(legacyMissingColsDb), 1);

    // Pre-versioned DB (user_version = 0) that already had all columns
    const legacyWithColsDb = join(dir, "legacy-with-cols.sqlite");
    const rawWithCols = new DatabaseSync(legacyWithColsDb);
    try {
      rawWithCols.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspaces_json TEXT NOT NULL,
          memory TEXT,
          models_json TEXT,
          tools_json TEXT,
          skills_policy_json TEXT,
          mcp_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      rawWithCols
        .prepare(
          "INSERT INTO projects (id, title, workspaces_json, memory, models_json, tools_json, skills_policy_json, mcp_json, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, 1, 1)",
        )
        .run(
          "legacy-2",
          "Legacy Two",
          JSON.stringify([dir]),
          JSON.stringify({ s: "user" }),
          JSON.stringify({ srv: { command: "cmd" } }),
        );
    } finally {
      rawWithCols.close();
    }

    const migratedWithCols = EngineStore.open(legacyWithColsDb);
    try {
      assert.equal(migratedWithCols.getProject("legacy-2")?.title, "Legacy Two");
      assert.deepEqual(migratedWithCols.getProjectSkillsPolicy("legacy-2"), { s: "user" });
      assert.deepEqual(migratedWithCols.getProjectMcpServers("legacy-2"), {
        srv: { command: "cmd" },
      });
    } finally {
      migratedWithCols.close();
    }

    assert.equal(readUserVersion(legacyWithColsDb), 1);

    // Corrupt stored JSON / schema-invalid config surfaces errors instead of returning {}
    const corruptDb = join(dir, "corrupt.sqlite");
    const setupCorrupt = EngineStore.open(corruptDb);
    setupCorrupt.setKv(KV_SETTINGS, { maxActiveWorkers: "not-a-number" });
    setupCorrupt.setKv(KV_SKILLS_POLICY, { broken: "invalid-mode" });
    setupCorrupt.close();

    const readCorrupt = EngineStore.open(corruptDb);
    try {
      assert.throws(() => readEngineSettings(readCorrupt), /Invalid stored kv "settings"/);
      assert.throws(() => readGlobalSkillsPolicy(readCorrupt), /Invalid stored kv "skills_policy"/);
    } finally {
      readCorrupt.close();
    }
  });
});
