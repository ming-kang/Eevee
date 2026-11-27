import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  LATEST_PROTOCOL_VERSION,
  type Tool as McpTool,
  type McpTransport,
  PipeTransport,
} from "@earendil-works/pi-mcp";
import type { McpServerEntry } from "@eevee/agent";
import {
  ConfigBundleSchema,
  EeveeApiError,
  EeveeClient,
  McpLogsResponseSchema,
  type McpOAuthEvent,
  McpStateResponseSchema,
  ProjectMcpStateResponseSchema,
  parseWithSchema,
  SkillsListResponseSchema,
} from "@eevee/protocol";
import {
  getMcpServersRecord,
  KV_MCP_SERVERS,
  readEngineSettings,
  readGlobalSkillsPolicy,
  readModelProfiles,
} from "../src/engine-config.ts";
import { Engine, EngineError, EngineStore, startForegroundEngine } from "../src/index.ts";

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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-engine-skills-mcp-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

class FakeMcpServer {
  tools: McpTool[];
  hangInitialize = false;
  openDelayMs = 0;
  openCount = 0;
  closeCount = 0;
  rootsChangedCount = 0;
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private link?: {
    readonly onStdout: (bytes: Uint8Array) => void;
    readonly finish: () => void;
    buffer: string;
    closed: boolean;
    nextReqId: number;
    pendingRequests: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>;
  };

  constructor(tools: McpTool[] = []) {
    this.tools = [...tools];
  }

  createTransport(): McpTransport {
    return new PipeTransport({
      closeTimeoutMs: 20,
      open: async (handlers) => {
        if (this.openDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.openDelayMs));
        }
        this.openCount += 1;
        let finish = () => {};
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const link = {
          onStdout: handlers.onStdout,
          finish,
          buffer: "",
          closed: false,
          nextReqId: 100,
          pendingRequests: new Map<
            number,
            { resolve: (val: unknown) => void; reject: (err: Error) => void }
          >(),
        };
        this.link = link;
        const close = () => {
          if (link.closed) return;
          link.closed = true;
          this.closeCount += 1;
          for (const pending of link.pendingRequests.values()) {
            pending.reject(new Error("closed"));
          }
          link.pendingRequests.clear();
          if (this.link === link) this.link = undefined;
          queueMicrotask(link.finish);
        };
        return {
          write: (data) => {
            if (link.closed) return;
            link.buffer +=
              typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
            for (;;) {
              const nl = link.buffer.indexOf("\n");
              if (nl < 0) return;
              const raw = link.buffer.slice(0, nl).trim();
              link.buffer = link.buffer.slice(nl + 1);
              if (raw) this.handleMessage(link, JSON.parse(raw) as Record<string, unknown>);
            }
          },
          closeStdin: close,
          close,
          exited,
        };
      },
    });
  }

  pushLog(level: string, logger: string, data: unknown): void {
    if (this.link && !this.link.closed) {
      this.send(this.link, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level, logger, data },
      });
    }
  }

  async requestRoots(): Promise<{ roots: { uri: string; name?: string }[] }> {
    const link = this.link;
    if (!link || link.closed) throw new Error("Not connected");
    const id = link.nextReqId++;
    return new Promise((resolve, reject) => {
      link.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      this.send(link, { jsonrpc: "2.0", id, method: "roots/list" });
    });
  }

  private send(link: NonNullable<FakeMcpServer["link"]>, msg: Record<string, unknown>): void {
    if (!link.closed) link.onStdout(this.encoder.encode(`${JSON.stringify(msg)}\n`));
  }

  private handleMessage(
    link: NonNullable<FakeMcpServer["link"]>,
    msg: Record<string, unknown>,
  ): void {
    if (!("method" in msg) && "id" in msg && typeof msg.id === "number") {
      const pending = link.pendingRequests.get(msg.id);
      if (pending) {
        link.pendingRequests.delete(msg.id);
        if ("error" in msg) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }
    if (!("id" in msg)) {
      if (msg.method === "notifications/roots/list_changed") {
        this.rootsChangedCount += 1;
      }
      return;
    }
    const id = msg.id;
    const method = msg.method;
    if (method === "initialize") {
      if (this.hangInitialize) return;
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, logging: {} },
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
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = params.name ?? "";
      const args = params.arguments ?? {};
      this.calls.push({ name, args });
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `called:${name}` }] },
      });
      return;
    }
    this.send(link, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  }
}

function mcpTool(name: string, description: string): McpTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
  };
}

function readHttpBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendHttpJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMockOAuthMcpServer(toolName = "whoami"): Promise<{
  readonly baseUrl: string;
  readonly mcpUrl: string;
  close(): Promise<void>;
}> {
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; codeChallenge: string; scope?: string }
  >();
  const validTokens = new Set<string>();
  let seq = 0;
  let baseUrl = "";

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", baseUrl);
    if (req.method === "GET" && reqUrl.pathname === "/.well-known/oauth-protected-resource") {
      sendHttpJson(res, 200, {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["mcp:read"],
      });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/.well-known/oauth-authorization-server") {
      sendHttpJson(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/register") {
      const payload = JSON.parse(await readHttpBody(req)) as Record<string, unknown>;
      const clientId = `client-${++seq}`;
      sendHttpJson(res, 201, {
        client_id: clientId,
        redirect_uris: payload.redirect_uris ?? [],
        client_name: payload.client_name,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/authorize") {
      const clientId = reqUrl.searchParams.get("client_id") ?? "";
      const redirectUri = reqUrl.searchParams.get("redirect_uri") ?? "";
      const state = reqUrl.searchParams.get("state") ?? "";
      const codeChallenge = reqUrl.searchParams.get("code_challenge") ?? "";
      const method = reqUrl.searchParams.get("code_challenge_method") ?? "";
      const scope = reqUrl.searchParams.get("scope") ?? undefined;
      if (!clientId || !redirectUri || !codeChallenge || method !== "S256") {
        sendHttpJson(res, 400, { error: "invalid_request" });
        return;
      }
      const code = `auth-code-${++seq}`;
      codes.set(code, { clientId, redirectUri, codeChallenge, scope });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      target.searchParams.set("iss", baseUrl);
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/token") {
      const params = new URLSearchParams(await readHttpBody(req));
      if (params.get("grant_type") !== "authorization_code") {
        sendHttpJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }
      const code = params.get("code") ?? "";
      const verifier = params.get("code_verifier") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const saved = codes.get(code);
      if (!saved) {
        sendHttpJson(res, 400, { error: "invalid_grant" });
        return;
      }
      codes.delete(code);
      const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
      if (expectedChallenge !== saved.codeChallenge || redirectUri !== saved.redirectUri) {
        sendHttpJson(res, 400, { error: "invalid_grant" });
        return;
      }
      const accessToken = `access-${++seq}`;
      validTokens.add(accessToken);
      sendHttpJson(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `refresh-${++seq}`,
        ...(saved.scope ? { scope: saved.scope } : {}),
      });
      return;
    }
    if (reqUrl.pathname === "/mcp") {
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      const authHeader = req.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!validTokens.has(token)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp:read"`,
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const msg = JSON.parse(await readHttpBody(req)) as Record<string, unknown>;
      if (!("id" in msg)) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "initialize") {
        sendHttpJson(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "mock-oauth-mcp", version: "1.0.0" },
          },
        });
        return;
      }
      if (msg.method === "tools/list") {
        sendHttpJson(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [mcpTool(toolName, "Identity check")] },
        });
        return;
      }
      if (msg.method === "tools/call") {
        sendHttpJson(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `authed:${token}` }] },
        });
        return;
      }
      sendHttpJson(res, 200, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Expected TCP address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test("Skills discovery, global & project policy overrides, config export/import, and /skill:<name> expansion", async () => {
  await withTempDir(async (dir) => {
    const homeA = join(dir, "home-a");
    const homeB = join(dir, "home-b");
    const userHome = join(dir, "user-home");
    const ws = join(dir, "workspace");

    await mkdir(join(userHome, ".agents", "skills", "global-manual"), { recursive: true });
    await mkdir(join(userHome, ".agents", "skills", "shared-skill"), { recursive: true });
    await mkdir(join(ws, ".agents", "skills", "ws-skill"), { recursive: true });
    await mkdir(join(ws, ".agents", "skills", "broken-skill"), { recursive: true });

    await writeFile(
      join(userHome, ".agents", "skills", "global-manual", "SKILL.md"),
      "---\nname: global-manual\ndescription: Global manual skill\ndisable-model-invocation: true\n---\nGlobal manual instructions.\n",
      "utf8",
    );
    await writeFile(
      join(userHome, ".agents", "skills", "shared-skill", "SKILL.md"),
      "---\nname: shared-skill\ndescription: Shared skill\n---\nShared skill body line.\n",
      "utf8",
    );
    await writeFile(
      join(ws, ".agents", "skills", "ws-skill", "SKILL.md"),
      "---\nname: ws-skill\ndescription: Workspace skill\n---\nWorkspace skill body line.\n",
      "utf8",
    );
    await writeFile(
      join(ws, ".agents", "skills", "broken-skill", "SKILL.md"),
      "---\nname: broken-skill\n---\nMissing description triggers error diagnostic.\n",
      "utf8",
    );

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const seenPrompts: string[] = [];
    const seenUserMessages: string[] = [];
    faux.setResponses(
      Array.from({ length: 10 }, () => (context: TranscriptContext) => {
        seenPrompts.push(getCurrentSystemPrompt(context.messages));
        const last = lastMessage(context);
        if (last?.role === "user") seenUserMessages.push(messageText(last));
        return fauxAssistantMessage("ack");
      }),
    );

    const engineA = await startForegroundEngine({
      dataDir: homeA,
      port: 0,
      userHomeDir: userHome,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    let exportedBundle: unknown;
    try {
      const client = new EeveeClient({ baseUrl: engineA.url, token: engineA.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "SkillsDemo" }))
        .project.id;

      const globalSkills = await client.listSkills();
      parseWithSchema(SkillsListResponseSchema, globalSkills);
      assert.deepEqual(
        globalSkills.skills.map((s) => [s.name, s.source, s.defaultMode, s.effectiveMode]),
        [
          ["global-manual", "global", "user", "user"],
          ["shared-skill", "global", "model", "model"],
        ],
      );
      assert.equal(globalSkills.projectPolicy, undefined);

      const projSkills = await client.skills(projectId).list();
      parseWithSchema(SkillsListResponseSchema, projSkills);
      assert.ok(projSkills.skills.some((s) => s.name === "ws-skill" && s.source === "workspace"));
      assert.ok(
        projSkills.diagnostics.some((d) => d.type === "error" && d.skillName === "broken-skill"),
      );

      const afterGlobal = await client.putSkillsPolicy({
        policy: { "shared-skill": "disabled", "global-manual": "model" },
      });
      assert.deepEqual(afterGlobal.globalPolicy, {
        "shared-skill": "disabled",
        "global-manual": "model",
      });
      assert.equal(
        afterGlobal.skills.find((s) => s.name === "shared-skill")?.effectiveMode,
        "disabled",
      );

      const bundle = await client.exportConfig();
      parseWithSchema(ConfigBundleSchema, bundle);
      assert.deepEqual(bundle.skillsPolicy, {
        "shared-skill": "disabled",
        "global-manual": "model",
      });
      exportedBundle = bundle;

      const afterProj = await client.skills(projectId).putPolicy({
        policy: { "shared-skill": "model", "ws-skill": "disabled" },
      });
      assert.deepEqual(afterProj.projectPolicy, {
        "shared-skill": "model",
        "ws-skill": "disabled",
      });
      const sharedEntry = afterProj.skills.find((s) => s.name === "shared-skill");
      assert.equal(sharedEntry?.globalOverride, "disabled");
      assert.equal(sharedEntry?.projectOverride, "model");
      assert.equal(sharedEntry?.effectiveMode, "model");

      await assert.rejects(
        client.sendMessage(projectId, "router", { text: "/skill:ws-skill do work" }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "skill_disabled" &&
          err.message.includes("ws-skill"),
      );
      assert.equal(seenUserMessages.length, 0);

      const handle = await engineA.engine.openProject(projectId);
      const sent = await client.sendMessage(projectId, "router", {
        text: "/skill:shared-skill analyze this",
      });
      await (await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT))?.wait(
        BACKGROUND_CONTEXT,
      );

      assert.equal(seenUserMessages.length, 1);
      assert.ok(seenUserMessages[0]?.includes('<skill name="shared-skill"'));
      assert.ok(seenUserMessages[0]?.includes("Shared skill body line."));
      assert.ok(seenUserMessages[0]?.endsWith("analyze this"));

      const prompt = seenPrompts[0] ?? "";
      assert.ok(prompt.includes("<name>global-manual</name>"));
      assert.ok(prompt.includes("<name>shared-skill</name>"));
      assert.equal(prompt.includes("<name>ws-skill</name>"), false);

      const clearedProj = await client.skills(projectId).putPolicy({ policy: null });
      assert.equal(clearedProj.projectPolicy, undefined);
      assert.equal(
        clearedProj.skills.find((s) => s.name === "shared-skill")?.effectiveMode,
        "disabled",
      );
      assert.equal(clearedProj.skills.find((s) => s.name === "ws-skill")?.effectiveMode, "model");

      await assert.rejects(
        client.sendMessage(projectId, "router", { text: "/skill:shared-skill retry" }),
        (err: unknown) => err instanceof EeveeApiError && err.problem.code === "skill_disabled",
      );

      const clearedGlobal = await client.putSkillsPolicy({ policy: {} });
      assert.deepEqual(clearedGlobal.globalPolicy, {});
      assert.equal((await client.exportConfig()).skillsPolicy, undefined);
    } finally {
      await engineA.close();
    }

    const engineB = await startForegroundEngine({
      dataDir: homeB,
      port: 0,
      userHomeDir: userHome,
      models,
    });
    try {
      const clientB = new EeveeClient({ baseUrl: engineB.url, token: engineB.token });
      const bundle = parseWithSchema(ConfigBundleSchema, exportedBundle);
      await clientB.importConfig(bundle);
      const skillsB = await clientB.listSkills();
      assert.deepEqual(skillsB.globalPolicy, {
        "shared-skill": "disabled",
        "global-manual": "model",
      });
    } finally {
      await engineB.close();
    }
  });
});

test("non-blocking Engine.open with slow MCP server, role filtering, and MCP logs endpoint", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const store = EngineStore.open(join(home, "engine.sqlite"));
    store.setKv(KV_MCP_SERVERS, {
      slow: { command: "slow-cmd", exposure: "direct" },
      routeronly: {
        command: "router-cmd",
        exposure: "direct",
        roles: { router: true, worker: false },
      },
      workeronly: {
        command: "worker-cmd",
        exposure: "direct",
        roles: { router: false, worker: true },
      },
      disabledsrv: { command: "disabled-cmd", enabled: false },
    });
    store.close();

    const slow = new FakeMcpServer([mcpTool("hang", "Never connects")]);
    slow.hangInitialize = true;
    const routerOnly = new FakeMcpServer([mcpTool("r_ping", "Router ping")]);
    const workerOnly = new FakeMcpServer([mcpTool("w_ping", "Worker ping")]);

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let routerTools: string[] = [];
    let workerTools: string[] = [];
    const brain: FauxResponseFactory = (context) => {
      const sys = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages).map((t) => t.name);
      const last = lastMessage(context);
      if (sys.includes("You are an Eevee Worker")) {
        workerTools = tools;
        return fauxAssistantMessage("worker-done");
      }
      routerTools = tools;
      if (last?.role === "user" && messageText(last).includes("delegate")) {
        return fauxAssistantMessage(
          [fauxToolCall("spawn_worker", { name: "w", prompt: "inspect" })],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("router-done");
    };
    faux.setResponses(Array.from({ length: 12 }, () => brain));

    const openStartedAt = Date.now();
    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "slow") return slow.createTransport();
        if (entry.name === "routeronly") return routerOnly.createTransport();
        if (entry.name === "workeronly") return workerOnly.createTransport();
        throw new Error(`Unexpected server ${entry.name}`);
      },
    });
    const openElapsedMs = Date.now() - openStartedAt;

    try {
      assert.ok(openElapsedMs < 2000, `Engine.open blocked for ${openElapsedMs}ms`);

      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      await waitFor(async () => {
        const state = await client.getMcpState();
        return (
          state.status.find((s) => s.name === "routeronly")?.status === "connected" &&
          state.status.find((s) => s.name === "workeronly")?.status === "connected"
        );
      }, "fast sibling MCP servers connected while slow stays connecting");

      const state = await client.getMcpState();
      parseWithSchema(McpStateResponseSchema, state);
      assert.equal(state.status.find((s) => s.name === "slow")?.status, "connecting");
      assert.equal(state.status.find((s) => s.name === "disabledsrv")?.status, "disabled");
      assert.deepEqual(state.status.find((s) => s.name === "routeronly")?.roles, {
        router: true,
        worker: false,
      });
      assert.deepEqual(state.status.find((s) => s.name === "workeronly")?.roles, {
        router: false,
        worker: true,
      });

      routerOnly.pushLog("info", "router-logger", "hello from router MCP");
      await waitFor(async () => {
        const logs = await client.getMcpLogs("routeronly");
        return logs.lines.some((line) => line.includes("router-logger: hello from router MCP"));
      }, "routeronly MCP log entry");
      const logsResp = await client.getMcpLogs("routeronly");
      parseWithSchema(McpLogsResponseSchema, logsResp);
      assert.equal(logsResp.server, "routeronly");
      assert.ok(logsResp.logPath?.endsWith("mcp.log"));

      await assert.rejects(
        client.getMcpLogs("nonexistent"),
        (err: unknown) => err instanceof EeveeApiError && err.status === 404,
      );

      const projectId = (await client.createProject({ workspaces: [ws], title: "Roles" })).project
        .id;
      const handle = await foreground.engine.openProject(projectId);
      const sent = await client.sendMessage(projectId, "router", { text: "delegate" });
      await (await handle.harness.submission(sent.submissionId as never, BACKGROUND_CONTEXT))?.wait(
        BACKGROUND_CONTEXT,
      );
      await waitFor(() => workerTools.length > 0, "worker run observed tools");

      assert.equal(routerTools.includes("mcp__routeronly__r_ping"), true);
      assert.equal(routerTools.includes("mcp__workeronly__w_ping"), false);
      assert.equal(workerTools.includes("mcp__workeronly__w_ping"), true);
      assert.equal(workerTools.includes("mcp__routeronly__r_ping"), false);
    } finally {
      await foreground.close();
    }
  });
});

test("MCP OAuth SSE sign-in, manual redirect input, cancellation, and logout", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const mock = await startMockOAuthMcpServer();

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "OAuth" })).project
        .id;
      const handle = await foreground.engine.openProject(projectId);

      const added = await client.upsertMcpServer("authed", {
        config: { type: "http", url: mock.mcpUrl, exposure: "direct" },
      });
      const snap = added.status.find((s) => s.name === "authed");
      assert.equal(snap?.status, "auth_required");
      assert.equal(snap?.authRequired, true);

      const started = await client.startMcpOAuth("authed");
      assert.equal(started.server, "authed");

      const events1: McpOAuthEvent[] = [];
      for await (const evt of client.streamMcpOAuth("authed", started.sessionId)) {
        events1.push(evt);
        if (evt.type === "auth_url") {
          const browserRes = await fetch(evt.url, { redirect: "follow" });
          assert.equal(browserRes.status, 200);
        }
      }
      assert.equal(events1[0]?.type, "auth_url");
      assert.equal(events1.at(-1)?.type, "complete");

      const stateAfter = await client.getMcpState();
      const connectedSnap = stateAfter.status.find((s) => s.name === "authed");
      assert.equal(connectedSnap?.status, "connected");
      assert.equal(connectedSnap?.toolCount, 1);
      const routerAgent = await handle.root.agent(BACKGROUND_CONTEXT);
      assert.equal(
        routerAgent.tools.some((t) => t.name === "mcp__authed__whoami"),
        true,
      );

      assert.deepEqual(await client.logoutMcpOAuth("authed"), { ok: true });
      const afterLogout = await client.getMcpState();
      assert.equal(afterLogout.status.find((s) => s.name === "authed")?.status, "auth_required");

      const started2 = await client.startMcpOAuth("authed");
      const events2: McpOAuthEvent[] = [];
      for await (const evt of client.streamMcpOAuth("authed", started2.sessionId)) {
        events2.push(evt);
        if (evt.type === "auth_url") {
          await assert.rejects(
            client.submitMcpOAuthInput("authed", started2.sessionId, {
              redirectUrl: "http://evil.example/cb?code=1&state=wrong",
            }),
            (err: unknown) => err instanceof EeveeApiError && err.status === 400,
          );
          const redirectRes = await fetch(evt.url, { redirect: "manual" });
          const location = redirectRes.headers.get("location");
          assert.ok(location);
          await client.submitMcpOAuthInput("authed", started2.sessionId, {
            redirectUrl: location,
          });
        }
      }
      assert.equal(events2.at(-1)?.type, "complete");
      assert.equal(
        (await client.getMcpState()).status.find((s) => s.name === "authed")?.status,
        "connected",
      );

      await client.logoutMcpOAuth("authed");
      const started3 = await client.startMcpOAuth("authed");
      const events3: McpOAuthEvent[] = [];
      for await (const evt of client.streamMcpOAuth("authed", started3.sessionId)) {
        events3.push(evt);
        if (evt.type === "auth_url") {
          await client.cancelMcpOAuth("authed", started3.sessionId);
        }
      }
      const last3 = events3.at(-1);
      assert.equal(last3?.type, "error");
      if (last3?.type === "error") {
        assert.equal(last3.code, "login_cancelled");
      }

      await assert.rejects(
        client.startMcpOAuth("missing"),
        (err: unknown) => err instanceof EeveeApiError && err.status === 404,
      );
    } finally {
      await foreground.close();
      await mock.close();
    }
  });
});

test("project-level MCP overrides, project-only server with multi-workspace roots, hibernation cleanup, and reopen persistence", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "ws-one");
    const ws2 = join(dir, "ws-two");
    const ws3 = join(dir, "ws-three");
    await Promise.all([
      mkdir(ws1, { recursive: true }),
      mkdir(ws2, { recursive: true }),
      mkdir(ws3, { recursive: true }),
    ]);

    const sharedSrv = new FakeMcpServer([mcpTool("shared_tool", "Shared tool")]);
    const toDisableSrv = new FakeMcpServer([mcpTool("disabled_tool", "To disable")]);
    const projOnlySrv = new FakeMcpServer([mcpTool("local_tool", "Project local tool")]);

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const mcpFactory = (entry: McpServerEntry) => {
      if (entry.name === "shared") return sharedSrv.createTransport();
      if (entry.name === "todisable") return toDisableSrv.createTransport();
      if (entry.name === "projonly") return projOnlySrv.createTransport();
      throw new Error(`Unexpected server ${entry.name}`);
    };

    let foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
        worker: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: mcpFactory,
    });

    let projectId: string;
    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      await client.putMcpConfig({
        servers: {
          shared: { command: "shared-cmd", exposure: "direct" },
          todisable: { command: "todisable-cmd", exposure: "direct" },
        },
      });

      projectId = (await client.createProject({ workspaces: [ws1, ws2], title: "ProjMcp" })).project
        .id;
      const handle = await foreground.engine.openProject(projectId);

      const openCountBefore = sharedSrv.openCount;
      const initialTools = (await handle.root.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
      assert.equal(initialTools.includes("mcp__shared__shared_tool"), true);
      assert.equal(initialTools.includes("mcp__todisable__disabled_tool"), true);

      await assert.rejects(
        client.mcp(projectId).upsertServer("ghost", { config: { enabled: false } }),
        (err: unknown) => err instanceof EeveeApiError && err.status === 400,
      );

      const projState = await client.mcp(projectId).putConfig({
        servers: {
          todisable: { enabled: false },
          shared: { roles: { router: false, worker: true } },
          projonly: { command: "projonly-cmd", exposure: "direct" },
        },
      });
      parseWithSchema(ProjectMcpStateResponseSchema, projState);
      assert.ok(sharedSrv.openCount > openCountBefore, "created dedicated project McpHub");
      assert.equal(projState.status.find((s) => s.name === "todisable")?.scope, "override");
      assert.equal(projState.status.find((s) => s.name === "todisable")?.status, "disabled");
      assert.equal(projState.status.find((s) => s.name === "shared")?.scope, "override");
      assert.equal(projState.status.find((s) => s.name === "projonly")?.scope, "project");
      assert.equal(projState.status.find((s) => s.name === "projonly")?.status, "connected");

      const afterTools = (await handle.root.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
      assert.equal(afterTools.includes("mcp__projonly__local_tool"), true);
      assert.equal(afterTools.includes("mcp__todisable__disabled_tool"), false);
      assert.equal(afterTools.includes("mcp__shared__shared_tool"), false);

      const roots1 = await projOnlySrv.requestRoots();
      assert.deepEqual(roots1.roots, [
        { uri: pathToFileURL(ws1).href, name: basename(ws1) },
        { uri: pathToFileURL(ws2).href, name: basename(ws2) },
      ]);

      await client.updateProject(projectId, { workspaces: [ws2, ws3] });
      await waitFor(() => projOnlySrv.rootsChangedCount === 1, "project roots list_changed");
      const roots2 = await projOnlySrv.requestRoots();
      assert.deepEqual(roots2.roots, [
        { uri: pathToFileURL(ws2).href, name: basename(ws2) },
        { uri: pathToFileURL(ws3).href, name: basename(ws3) },
      ]);

      projOnlySrv.pushLog("warn", "proj-logger", "project specific log line");
      await waitFor(async () => {
        const logs = await client.mcp(projectId).getLogs("projonly");
        return logs.lines.some((line) => line.includes("proj-logger: project specific log line"));
      }, "project MCP logs");

      const closeCountBeforeHibernate = projOnlySrv.closeCount;
      const hibernated = await foreground.engine.hibernateIdleProjects(Date.now() + 60 * 60_000);
      assert.deepEqual(hibernated, [projectId]);
      assert.equal(foreground.engine.isProjectOpen(projectId), false);
      await waitFor(
        () => projOnlySrv.closeCount > closeCountBeforeHibernate,
        "project McpHub transport closed on hibernation",
      );

      const offlineState = await client.mcp(projectId).getState();
      assert.equal(offlineState.status.find((s) => s.name === "projonly")?.status, "idle");
      assert.equal(offlineState.status.find((s) => s.name === "todisable")?.status, "disabled");

      const reconnected = await client.mcp(projectId).reconnect({ server: "projonly" });
      assert.equal(reconnected.status.find((s) => s.name === "projonly")?.status, "connected");
      assert.equal(foreground.engine.isProjectOpen(projectId), true);
    } finally {
      await foreground.close();
    }

    const prevOpens = projOnlySrv.openCount;
    foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: mcpFactory,
    });
    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const reopenedState = await client.mcp(projectId).getState();
      assert.ok(Object.hasOwn(reopenedState.projectServers, "projonly"));
      assert.ok(Object.hasOwn(reopenedState.projectServers, "todisable"));

      const reopenedHandle = await foreground.engine.openProject(projectId);
      await waitFor(() => projOnlySrv.openCount > prevOpens, "reopened project hub connected");
      await waitFor(async () => {
        const names = (await reopenedHandle.root.agent(BACKGROUND_CONTEXT)).tools.map(
          (t) => t.name,
        );
        return names.includes("mcp__projonly__local_tool");
      }, "persisted projonly tool active after Engine reopen");

      await client.mcp(projectId).deleteServer("todisable");
      await client.mcp(projectId).deleteServer("shared");
      const afterClear = await client.mcp(projectId).deleteServer("projonly");
      assert.deepEqual(afterClear.projectServers, {});
      assert.equal(
        afterClear.status.some((s) => s.name === "projonly"),
        false,
      );

      await waitFor(async () => {
        const names = (await reopenedHandle.root.agent(BACKGROUND_CONTEXT)).tools.map(
          (t) => t.name,
        );
        return (
          names.includes("mcp__shared__shared_tool") &&
          names.includes("mcp__todisable__disabled_tool") &&
          !names.includes("mcp__projonly__local_tool")
        );
      }, "switched back to global shared McpHub");
    } finally {
      await foreground.close();
    }
  });
});

test("Engine.open starts background connections without blocking on slow server directly", async () => {
  await withTempDir(async (dir) => {
    const store = EngineStore.open(join(dir, "engine.sqlite"));
    store.setKv(KV_MCP_SERVERS, {
      slow: { command: "slow-cmd" },
    });
    store.close();

    const slow = new FakeMcpServer([mcpTool("never", "Never ready")]);
    slow.hangInitialize = true;

    const start = Date.now();
    const engine = await Engine.open({
      dataDir: dir,
      userHomeDir: null,
      createMcpTransport: () => slow.createTransport(),
    });
    try {
      assert.ok(Date.now() - start < 1000, "Engine.open must not await slow MCP initialize");
      assert.equal(engine.mcp().getState().status[0]?.status, "connecting");
    } finally {
      await engine.close();
    }
  });
});

test("concurrent project MCP mutations serialize per project without leaking hubs or transports", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const srvA = new FakeMcpServer([mcpTool("tool_a", "Tool A")]);
    srvA.openDelayMs = 30;
    const srvB = new FakeMcpServer([mcpTool("tool_b", "Tool B")]);
    srvB.openDelayMs = 30;

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "srva") return srvA.createTransport();
        if (entry.name === "srvb") return srvB.createTransport();
        throw new Error(`Unexpected server ${entry.name}`);
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "ConcurrentMcp" }))
        .project.id;
      const handle = await foreground.engine.openProject(projectId);

      await Promise.all([
        client.mcp(projectId).upsertServer("srva", {
          config: { command: "a-cmd", exposure: "direct" },
        }),
        client.mcp(projectId).upsertServer("srvb", {
          config: { command: "b-cmd", exposure: "direct" },
        }),
      ]);

      assert.equal(srvA.openCount, 1, "srvA should open only once without duplicate hub");
      assert.equal(srvB.openCount, 1, "srvB should open only once");
      assert.equal(srvA.closeCount, 0, "srvA should remain open on the project hub");
      assert.equal(srvB.closeCount, 0, "srvB should remain open on the project hub");

      const agentTools = (await handle.root.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
      assert.equal(agentTools.includes("mcp__srva__tool_a"), true);
      assert.equal(agentTools.includes("mcp__srvb__tool_b"), true);

      await client.mcp(projectId).deleteServer("srvb");
      await Promise.all([
        client.mcp(projectId).upsertServer("srvb", {
          config: { command: "b-cmd", exposure: "direct" },
        }),
        client.mcp(projectId).deleteServer("srva"),
      ]);
      await client.mcp(projectId).putConfig({ servers: {} });
      await Promise.all([
        client.mcp(projectId).upsertServer("srva", {
          config: { command: "a-cmd", exposure: "direct" },
        }),
        client
          .mcp(projectId)
          .deleteServer("srva")
          .catch(() => undefined),
      ]);
    } finally {
      await foreground.close();
    }

    assert.equal(srvA.openCount, srvA.closeCount, "all srvA transports must be closed");
    assert.equal(srvB.openCount, srvB.closeCount, "all srvB transports must be closed");
  });
});

test("global MCP delete, putMcpConfig, and importConfig prune orphan project partial overrides and preserve project-only servers", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const s1 = new FakeMcpServer([mcpTool("t1", "Tool 1")]);
    const s2 = new FakeMcpServer([mcpTool("t2", "Tool 2")]);
    const s3 = new FakeMcpServer([mcpTool("t3", "Tool 3")]);
    const projFull = new FakeMcpServer([mcpTool("pf", "Project full")]);

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "s1") return s1.createTransport();
        if (entry.name === "s2") return s2.createTransport();
        if (entry.name === "s3") return s3.createTransport();
        if (entry.name === "projfull") return projFull.createTransport();
        throw new Error(`Unexpected server ${entry.name}`);
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      await client.putMcpConfig({
        servers: {
          s1: { command: "s1-cmd", exposure: "direct" },
          s2: { command: "s2-cmd", exposure: "direct" },
        },
      });

      const projectId = (await client.createProject({ workspaces: [ws], title: "OrphanPrune" }))
        .project.id;
      const handle = await foreground.engine.openProject(projectId);

      await client.mcp(projectId).putConfig({
        servers: {
          s1: { enabled: false },
          projfull: { command: "pf-cmd", exposure: "direct" },
        },
      });

      await client.deleteMcpServer("s1");
      const stateAfterDelete = await client.mcp(projectId).getState();
      assert.equal(Object.hasOwn(stateAfterDelete.projectServers, "s1"), false);
      assert.equal(Object.hasOwn(stateAfterDelete.projectServers, "projfull"), true);

      await client.mcp(projectId).upsertServer("s2", { config: { enabled: false } });
      await client.mcp(projectId).deleteServer("projfull");

      const s2ClosesBefore = s2.closeCount;
      await client.putMcpConfig({
        servers: {
          s3: { command: "s3-cmd", exposure: "direct" },
        },
      });
      const stateAfterPut = await client.mcp(projectId).getState();
      assert.deepEqual(stateAfterPut.projectServers, {});
      assert.ok(s2.closeCount > s2ClosesBefore, "project hub torn down on last override prune");

      await waitFor(async () => {
        const names = (await handle.root.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
        return names.includes("mcp__s3__t3") && !names.includes("mcp__s2__t2");
      }, "open project rebound to global hub with s3 after last override pruned");

      await client.mcp(projectId).upsertServer("s3", {
        config: { roles: { router: false } },
      });

      const bundle = await client.exportConfig();
      await client.importConfig({ ...bundle, mcpServers: {} });
      assert.deepEqual((await client.mcp(projectId).getState()).projectServers, {});
    } finally {
      await foreground.close();
    }
  });
});

test("HTTP MCP deletion/URL change cleans up OAuth sessions and mcp-auth.json credentials unless still referenced, and re-login cancels prior fixed-port session", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const mock1 = await startMockOAuthMcpServer();
    const mock2 = await startMockOAuthMcpServer();

    const probeServer = createServer();
    await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = probeServer.address();
    if (addr === null || typeof addr === "string") throw new Error("Expected TCP port");
    const fixedPort = addr.port;
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "OAuthCleanup" }))
        .project.id;

      await client.upsertMcpServer("fixed", {
        config: {
          type: "http",
          url: mock1.mcpUrl,
          exposure: "direct",
          oauth: { callbackPort: fixedPort },
        },
      });

      const firstSession = await client.startMcpOAuth("fixed");
      const firstEvents: McpOAuthEvent[] = [];
      let firstGotAuthUrl!: () => void;
      const firstReady = new Promise<void>((resolve) => {
        firstGotAuthUrl = resolve;
      });
      const firstStreamTask = (async () => {
        for await (const evt of client.streamMcpOAuth("fixed", firstSession.sessionId)) {
          firstEvents.push(evt);
          if (evt.type === "auth_url") {
            firstGotAuthUrl();
          }
        }
      })();

      await firstReady;

      const secondSession = await client.startMcpOAuth("fixed");
      await firstStreamTask;
      const lastFirst = firstEvents.at(-1);
      assert.equal(lastFirst?.type, "error");
      if (lastFirst?.type === "error") {
        assert.equal(lastFirst.code, "login_cancelled");
      }

      const secondEvents: McpOAuthEvent[] = [];
      for await (const evt of client.streamMcpOAuth("fixed", secondSession.sessionId)) {
        secondEvents.push(evt);
        if (evt.type === "auth_url") {
          assert.equal(new URL(evt.redirectUrl).port, String(fixedPort));
          const res = await fetch(evt.url, { redirect: "follow" });
          assert.equal(res.status, 200);
        }
      }
      assert.equal(secondEvents.at(-1)?.type, "complete");
      assert.equal(await foreground.engine.oauthStore.hasTokens("fixed", mock1.mcpUrl), true);

      await client.deleteMcpServer("fixed");
      assert.equal(await foreground.engine.oauthStore.hasTokens("fixed", mock1.mcpUrl), false);
      const authJsonAfterDelete = JSON.parse(
        await readFile(foreground.engine.oauthStore.filePath, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(Object.keys(authJsonAfterDelete).length, 0);

      await client.upsertMcpServer("pendingauth", {
        config: { type: "http", url: mock1.mcpUrl, exposure: "direct" },
      });
      const thirdSession = await client.startMcpOAuth("pendingauth");
      const thirdEvents: McpOAuthEvent[] = [];
      let thirdGotAuthUrl!: () => void;
      let thirdFailed!: (error: Error) => void;
      const thirdReady = new Promise<void>((resolve, reject) => {
        thirdGotAuthUrl = resolve;
        thirdFailed = reject;
      });
      const thirdStreamTask = (async () => {
        let sawAuthUrl = false;
        for await (const evt of client.streamMcpOAuth("pendingauth", thirdSession.sessionId)) {
          thirdEvents.push(evt);
          if (evt.type === "auth_url") {
            sawAuthUrl = true;
            thirdGotAuthUrl();
          }
        }
        if (!sawAuthUrl) {
          thirdFailed(new Error("Expected auth_url event before stream ended"));
        }
      })();
      await thirdReady;

      await client.deleteMcpServer("pendingauth");
      await thirdStreamTask;
      const lastThird = thirdEvents.at(-1);
      assert.equal(lastThird?.type, "error");
      if (lastThird?.type === "error") {
        assert.equal(lastThird.code, "login_cancelled");
      }

      await client.upsertMcpServer("sharedhttp", {
        config: { type: "http", url: mock1.mcpUrl, exposure: "direct" },
      });
      const s4 = await client.startMcpOAuth("sharedhttp");
      for await (const evt of client.streamMcpOAuth("sharedhttp", s4.sessionId)) {
        if (evt.type === "auth_url") {
          const res = await fetch(evt.url, { redirect: "follow" });
          assert.equal(res.status, 200);
        }
      }
      assert.equal(await foreground.engine.oauthStore.hasTokens("sharedhttp", mock1.mcpUrl), true);

      await client.mcp(projectId).upsertServer("sharedhttp", {
        config: { type: "http", url: mock1.mcpUrl, exposure: "direct" },
      });
      await client.deleteMcpServer("sharedhttp");
      assert.equal(await foreground.engine.oauthStore.hasTokens("sharedhttp", mock1.mcpUrl), true);

      await client.mcp(projectId).upsertServer("sharedhttp", {
        config: { type: "http", url: mock2.mcpUrl, exposure: "direct" },
      });
      assert.equal(await foreground.engine.oauthStore.hasTokens("sharedhttp", mock1.mcpUrl), false);
    } finally {
      await foreground.close();
      await mock1.close();
      await mock2.close();
    }
  });
});

function watchOAuthUntilAuthUrl(stream: AsyncIterable<McpOAuthEvent>): {
  readonly ready: Promise<Extract<McpOAuthEvent, { readonly type: "auth_url" }>>;
  readonly events: McpOAuthEvent[];
  readonly done: Promise<void>;
} {
  const events: McpOAuthEvent[] = [];
  let resolveReady!: (event: Extract<McpOAuthEvent, { readonly type: "auth_url" }>) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<Extract<McpOAuthEvent, { readonly type: "auth_url" }>>(
    (resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    },
  );
  const done = (async () => {
    let sawAuthUrl = false;
    try {
      for await (const evt of stream) {
        events.push(evt);
        if (evt.type === "auth_url" && !sawAuthUrl) {
          sawAuthUrl = true;
          resolveReady(evt);
        }
      }
      if (!sawAuthUrl) {
        rejectReady(new Error("Expected auth_url event before SSE stream closed"));
      }
    } catch (error) {
      if (!sawAuthUrl) {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  })();
  return { ready, events, done };
}

test("project-scoped MCP OAuth sign-in, tool exposure, manual redirect, cancel, and logout for project-only HTTP servers", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const mock = await startMockOAuthMcpServer("proj_whoami");

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const projectId = (await client.createProject({ workspaces: [ws], title: "ProjOAuth" }))
        .project.id;
      const handle = await foreground.engine.openProject(projectId);

      const added = await client.mcp(projectId).upsertServer("projhttp", {
        config: { type: "http", url: mock.mcpUrl, exposure: "direct" },
      });
      const initialSnap = added.status.find((s) => s.name === "projhttp");
      assert.equal(initialSnap?.scope, "project");
      assert.equal(initialSnap?.status, "auth_required");
      assert.equal(initialSnap?.authRequired, true);
      assert.equal(
        (await client.getMcpState()).status.some((s) => s.name === "projhttp"),
        false,
      );

      const started = await client.mcp(projectId).startOAuth("projhttp");
      assert.equal(started.server, "projhttp");

      const events: McpOAuthEvent[] = [];
      for await (const evt of client.mcp(projectId).streamOAuth("projhttp", started.sessionId)) {
        events.push(evt);
        if (evt.type === "auth_url") {
          const browserRes = await fetch(evt.url, { redirect: "follow" });
          assert.equal(browserRes.status, 200);
        }
      }
      assert.equal(events[0]?.type, "auth_url");
      assert.equal(events.at(-1)?.type, "complete");

      const stateAfter = await client.mcp(projectId).getState();
      const connectedSnap = stateAfter.status.find((s) => s.name === "projhttp");
      assert.equal(connectedSnap?.status, "connected");
      assert.equal(connectedSnap?.toolCount, 1);
      assert.equal(connectedSnap?.tools?.[0]?.name, "proj_whoami");
      const routerAgent = await handle.root.agent(BACKGROUND_CONTEXT);
      assert.equal(
        routerAgent.tools.some((t) => t.name === "mcp__projhttp__proj_whoami"),
        true,
      );

      assert.deepEqual(await client.mcp(projectId).logoutOAuth("projhttp"), { ok: true });
      assert.equal(await foreground.engine.oauthStore.hasTokens("projhttp", mock.mcpUrl), false);
      const afterLogout = await client.mcp(projectId).getState();
      assert.equal(afterLogout.status.find((s) => s.name === "projhttp")?.status, "auth_required");
      const routerAgentAfterLogout = await handle.root.agent(BACKGROUND_CONTEXT);
      assert.equal(
        routerAgentAfterLogout.tools.some((t) => t.name === "mcp__projhttp__proj_whoami"),
        false,
      );

      const started2 = await client.mcp(projectId).startOAuth("projhttp");
      const events2: McpOAuthEvent[] = [];
      for await (const evt of client.mcp(projectId).streamOAuth("projhttp", started2.sessionId)) {
        events2.push(evt);
        if (evt.type === "auth_url") {
          const redirectRes = await fetch(evt.url, { redirect: "manual" });
          const location = redirectRes.headers.get("location");
          assert.ok(location);
          await client.mcp(projectId).submitOAuthInput("projhttp", started2.sessionId, {
            redirectUrl: location,
          });
        }
      }
      assert.equal(events2.at(-1)?.type, "complete");
      assert.equal(
        (await client.mcp(projectId).getState()).status.find((s) => s.name === "projhttp")?.status,
        "connected",
      );

      await client.mcp(projectId).logoutOAuth("projhttp");
      const started3 = await client.mcp(projectId).startOAuth("projhttp");
      const events3: McpOAuthEvent[] = [];
      for await (const evt of client.mcp(projectId).streamOAuth("projhttp", started3.sessionId)) {
        events3.push(evt);
        if (evt.type === "auth_url") {
          await client.mcp(projectId).cancelOAuth("projhttp", started3.sessionId);
        }
      }
      const last3 = events3.at(-1);
      assert.equal(last3?.type, "error");
      if (last3?.type === "error") {
        assert.equal(last3.code, "login_cancelled");
      }
    } finally {
      await foreground.close();
      await mock.close();
    }
  });
});

test("project URL override authenticates against mock2 without authenticating global mock1", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "ws-1");
    const ws2 = join(dir, "ws-2");
    await Promise.all([mkdir(ws1, { recursive: true }), mkdir(ws2, { recursive: true })]);
    const mock1 = await startMockOAuthMcpServer("from_mock1");
    const mock2 = await startMockOAuthMcpServer("from_mock2");

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      await client.upsertMcpServer("shared", {
        config: { type: "http", url: mock1.mcpUrl, exposure: "direct" },
      });

      const p1 = (await client.createProject({ workspaces: [ws1], title: "OverrideUrl" })).project
        .id;
      const p2 = (await client.createProject({ workspaces: [ws2], title: "InheritedUrl" })).project
        .id;

      const h1 = await foreground.engine.openProject(p1);
      await foreground.engine.openProject(p2);

      const overrideState = await client.mcp(p1).upsertServer("shared", {
        config: { type: "http", url: mock2.mcpUrl, exposure: "direct" },
      });
      const p1Snap = overrideState.status.find((s) => s.name === "shared");
      assert.equal(p1Snap?.scope, "override");
      assert.equal(p1Snap?.status, "auth_required");

      const started = await client.mcp(p1).startOAuth("shared");
      const events: McpOAuthEvent[] = [];
      for await (const evt of client.mcp(p1).streamOAuth("shared", started.sessionId)) {
        events.push(evt);
        if (evt.type === "auth_url") {
          assert.ok(evt.url.startsWith(mock2.baseUrl), `Expected mock2 auth URL, got ${evt.url}`);
          const res = await fetch(evt.url, { redirect: "follow" });
          assert.equal(res.status, 200);
        }
      }
      assert.equal(events.at(-1)?.type, "complete");

      const p1After = await client.mcp(p1).getState();
      const p1Connected = p1After.status.find((s) => s.name === "shared");
      assert.equal(p1Connected?.status, "connected");
      assert.deepEqual(
        p1Connected?.tools?.map((t) => t.name),
        ["from_mock2"],
      );
      const p1Tools = (await h1.root.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
      assert.equal(p1Tools.includes("mcp__shared__from_mock2"), true);
      assert.equal(p1Tools.includes("mcp__shared__from_mock1"), false);

      assert.equal(await foreground.engine.oauthStore.hasTokens("shared", mock2.mcpUrl), true);
      assert.equal(await foreground.engine.oauthStore.hasTokens("shared", mock1.mcpUrl), false);
      assert.equal(
        (await client.getMcpState()).status.find((s) => s.name === "shared")?.status,
        "auth_required",
      );
      assert.equal(
        (await client.mcp(p2).getState()).status.find((s) => s.name === "shared")?.status,
        "auth_required",
      );
    } finally {
      await foreground.close();
      await mock1.close();
      await mock2.close();
    }
  });
});

test("project-scoped MCP OAuth error paths, cross-scope session isolation, and scoped cancellation", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws1 = join(dir, "ws-1");
    const ws2 = join(dir, "ws-2");
    await Promise.all([mkdir(ws1, { recursive: true }), mkdir(ws2, { recursive: true })]);
    const mock1 = await startMockOAuthMcpServer("tool1");
    const mock2 = await startMockOAuthMcpServer("tool2");

    const stdioSrv = new FakeMcpServer([mcpTool("stdio_tool", "Stdio tool")]);

    const faux = fauxProvider({ models: [{ id: MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const foreground = await startForegroundEngine({
      dataDir: home,
      port: 0,
      userHomeDir: null,
      models,
      defaultModelSlots: {
        router: { provider: faux.provider.id, modelId: MODEL_ID },
      },
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "stdiosrv") return stdioSrv.createTransport();
        throw new Error(`Unexpected stdio transport request for ${entry.name}`);
      },
    });

    try {
      const client = new EeveeClient({ baseUrl: foreground.url, token: foreground.token });
      const p1 = (await client.createProject({ workspaces: [ws1], title: "Errors1" })).project.id;
      const p2 = (await client.createProject({ workspaces: [ws2], title: "Errors2" })).project.id;

      await client.putMcpConfig({
        servers: {
          shared: { type: "http", url: mock1.mcpUrl, exposure: "direct" },
          inherited: { type: "http", url: mock1.mcpUrl, exposure: "direct" },
          stdiosrv: { command: "stdio-cmd" },
          disabledsrv: { type: "http", url: mock1.mcpUrl, enabled: false },
        },
      });
      await client.mcp(p1).upsertServer("shared", {
        config: { type: "http", url: mock2.mcpUrl, exposure: "direct" },
      });

      await assert.rejects(
        client.mcp("missing-project").startOAuth("shared"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "project_not_found",
      );
      await assert.rejects(
        client.mcp("missing-project").logoutOAuth("shared"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "project_not_found",
      );

      await assert.rejects(
        client.mcp(p1).startOAuth("no-such-server"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "mcp_server_not_found",
      );

      await assert.rejects(
        client.mcp(p1).startOAuth("stdiosrv"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "mcp_oauth_unsupported",
      );
      await assert.rejects(
        client.mcp(p1).logoutOAuth("stdiosrv"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 400 &&
          err.problem.code === "mcp_oauth_unsupported",
      );

      await assert.rejects(
        client.mcp(p1).startOAuth("disabledsrv"),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 409 &&
          err.problem.code === "mcp_server_disabled",
      );
      assert.deepEqual(await client.mcp(p1).logoutOAuth("disabledsrv"), { ok: true });

      const globalSess = await client.startMcpOAuth("shared");
      const globalWatcher = watchOAuthUntilAuthUrl(
        client.streamMcpOAuth("shared", globalSess.sessionId),
      );
      await globalWatcher.ready;

      const projSess = await client.mcp(p1).startOAuth("shared");
      const projWatcher = watchOAuthUntilAuthUrl(
        client.mcp(p1).streamOAuth("shared", projSess.sessionId),
      );
      const projAuthEvent = await projWatcher.ready;
      assert.ok(projAuthEvent.url.startsWith(mock2.baseUrl));

      await assert.rejects(
        async () => {
          for await (const _ of client.mcp(p1).streamOAuth("shared", globalSess.sessionId)) {
          }
        },
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "mcp_oauth_session_not_found",
      );
      await assert.rejects(
        client.mcp(p1).submitOAuthInput("shared", globalSess.sessionId, {
          redirectUrl: "http://127.0.0.1/cb",
        }),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "mcp_oauth_session_not_found",
      );
      await assert.rejects(
        client.mcp(p1).cancelOAuth("shared", globalSess.sessionId),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "mcp_oauth_session_not_found",
      );
      await assert.rejects(
        client.cancelMcpOAuth("shared", projSess.sessionId),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "mcp_oauth_session_not_found",
      );
      await assert.rejects(
        client.mcp(p2).cancelOAuth("shared", projSess.sessionId),
        (err: unknown) =>
          err instanceof EeveeApiError &&
          err.status === 404 &&
          err.problem.code === "mcp_oauth_session_not_found",
      );

      await client.mcp(p1).deleteServer("shared");
      await projWatcher.done;
      const lastProjEvt = projWatcher.events.at(-1);
      assert.equal(lastProjEvt?.type, "error");
      if (lastProjEvt?.type === "error") {
        assert.equal(lastProjEvt.code, "login_cancelled");
      }

      const globalAuthEvent = globalWatcher.events.find((e) => e.type === "auth_url");
      assert.ok(globalAuthEvent && globalAuthEvent.type === "auth_url");
      const globalBrowserRes = await fetch(globalAuthEvent.url, { redirect: "follow" });
      assert.equal(globalBrowserRes.status, 200);
      await globalWatcher.done;
      assert.equal(globalWatcher.events.at(-1)?.type, "complete");

      await client.mcp(p1).upsertServer("shared", {
        config: { type: "http", url: mock2.mcpUrl, exposure: "direct" },
      });
      const inheritedSess = await client.mcp(p1).startOAuth("inherited");
      const inheritedWatcher = watchOAuthUntilAuthUrl(
        client.mcp(p1).streamOAuth("inherited", inheritedSess.sessionId),
      );
      await inheritedWatcher.ready;

      const overriddenSess = await client.mcp(p1).startOAuth("shared");
      const overriddenWatcher = watchOAuthUntilAuthUrl(
        client.mcp(p1).streamOAuth("shared", overriddenSess.sessionId),
      );
      const overriddenAuth = await overriddenWatcher.ready;

      await client.deleteMcpServer("inherited");
      await client.deleteMcpServer("shared");

      await inheritedWatcher.done;
      const lastInherited = inheritedWatcher.events.at(-1);
      assert.equal(lastInherited?.type, "error");
      if (lastInherited?.type === "error") {
        assert.equal(lastInherited.code, "login_cancelled");
      }

      const overriddenRes = await fetch(overriddenAuth.url, { redirect: "follow" });
      assert.equal(overriddenRes.status, 200);
      await overriddenWatcher.done;
      assert.equal(overriddenWatcher.events.at(-1)?.type, "complete");
    } finally {
      await foreground.close();
      await mock1.close();
      await mock2.close();
    }
  });
});

test("replaceMcpServers rolls back global KV and pruned project overrides when mcpHub.reload fails", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const g1 = new FakeMcpServer([mcpTool("t1", "Tool 1")]);
    const projOnly = new FakeMcpServer([mcpTool("tp", "Project Tool")]);

    const engine = await Engine.open({
      dataDir: home,
      userHomeDir: null,
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "g1") return g1.createTransport();
        if (entry.name === "projonly") return projOnly.createTransport();
        throw new Error(`Unexpected server ${entry.name}`);
      },
    });

    try {
      await engine.mcp().putConfig({
        servers: { g1: { command: "g1-cmd", exposure: "direct" } },
      });
      const project = engine.projects.create({ workspaces: [ws], title: "RollbackTest" });
      await engine.mcp(project.id).putConfig({
        servers: {
          g1: { enabled: false },
          projonly: { command: "proj-cmd", exposure: "direct" },
        },
      });

      const originalReload = engine.mcpHub.reload.bind(engine.mcpHub);
      let failReload = true;
      engine.mcpHub.reload = async (servers) => {
        if (failReload) {
          failReload = false;
          throw new Error("simulated reload failure");
        }
        return originalReload(servers);
      };

      await assert.rejects(engine.mcp().deleteServer("g1"), /simulated reload failure/);

      assert.deepEqual(getMcpServersRecord(engine.store), {
        g1: { command: "g1-cmd", exposure: "direct" },
      });
      assert.deepEqual(engine.store.getProjectMcpServers(project.id), {
        g1: { enabled: false },
        projonly: { command: "proj-cmd", exposure: "direct" },
      });
      assert.equal(
        engine.mcpHub.status().some((snap) => snap.name === "g1"),
        true,
      );
    } finally {
      await engine.close();
    }
  });
});

test("concurrent global MCP mutations serialize cleanly without diverging SQLite, mcpHub, or rollback", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");

    const servers = new Map<string, FakeMcpServer>([
      ["s1", new FakeMcpServer([mcpTool("t1", "Tool 1")])],
      ["s2", new FakeMcpServer([mcpTool("t2", "Tool 2")])],
      ["s3", new FakeMcpServer([mcpTool("t3", "Tool 3")])],
      ["s4", new FakeMcpServer([mcpTool("t4", "Tool 4")])],
      ["bad_fail", new FakeMcpServer([mcpTool("tb", "Tool Bad")])],
    ]);
    for (const srv of servers.values()) {
      srv.openDelayMs = 20;
    }

    const engine = await Engine.open({
      dataDir: home,
      userHomeDir: null,
      createMcpTransport: (entry: McpServerEntry) => {
        const srv = servers.get(entry.name);
        if (srv === undefined) throw new Error(`Unexpected server ${entry.name}`);
        return srv.createTransport();
      },
    });

    try {
      const originalReload = engine.mcpHub.reload.bind(engine.mcpHub);
      engine.mcpHub.reload = async (entries) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (entries.some((entry) => entry.name === "bad_fail")) {
          throw new Error("simulated bad_fail reload error");
        }
        return originalReload(entries);
      };

      await Promise.all([
        engine.mcp().upsertServer("s1", { config: { command: "cmd-1", exposure: "direct" } }),
        engine.mcp().upsertServer("s2", { config: { command: "cmd-2", exposure: "direct" } }),
        engine.mcp().upsertServer("s3", { config: { command: "cmd-3", exposure: "direct" } }),
      ]);

      assert.deepEqual(Object.keys(getMcpServersRecord(engine.store)).sort(), ["s1", "s2", "s3"]);
      assert.deepEqual(
        engine.mcpHub
          .status()
          .map((snap) => snap.name)
          .sort(),
        ["s1", "s2", "s3"],
      );

      const results = await Promise.allSettled([
        engine.mcp().deleteServer("s2"),
        engine.mcp().upsertServer("s4", { config: { command: "cmd-4", exposure: "direct" } }),
        engine
          .mcp()
          .upsertServer("bad_fail", { config: { command: "cmd-bad", exposure: "direct" } }),
      ]);
      assert.equal(results[0].status, "fulfilled");
      assert.equal(results[1].status, "fulfilled");
      assert.equal(results[2].status, "rejected");

      assert.deepEqual(Object.keys(getMcpServersRecord(engine.store)).sort(), ["s1", "s3", "s4"]);
      assert.deepEqual(
        engine.mcpHub
          .status()
          .map((snap) => snap.name)
          .sort(),
        ["s1", "s3", "s4"],
      );
    } finally {
      await engine.close();
    }
  });
});

test("importConfig rolls back SQLite KV, pruned project overrides, models.json, and modelRuntime on mcpHub.reload failure without deleting OAuth credentials", async () => {
  await withTempDir(async (dir) => {
    const homeWithModels = join(dir, "home-with-models");
    const homeWithoutModels = join(dir, "home-without-models");
    const ws = join(dir, "ws");
    await mkdir(homeWithModels, { recursive: true });
    await mkdir(ws, { recursive: true });

    const initialModelsRaw = `${JSON.stringify(
      {
        providers: {
          "orig-p": {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-responses",
            apiKey: "orig-key",
            models: [{ id: "orig-1", name: "Original Model" }],
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(join(homeWithModels, "models.json"), initialModelsRaw, "utf8");

    const g1 = new FakeMcpServer([mcpTool("t1", "Tool 1")]);
    const projOnly = new FakeMcpServer([mcpTool("tp", "Project Tool")]);
    const g1Url = "http://127.0.0.1:9999/mcp";

    const engineA = await Engine.open({
      dataDir: homeWithModels,
      userHomeDir: null,
      createMcpTransport: (entry: McpServerEntry) => {
        if (entry.name === "g1") return g1.createTransport();
        if (entry.name === "projonly") return projOnly.createTransport();
        throw new Error(`Unexpected server ${entry.name}`);
      },
    });

    try {
      await engineA.settings.put({ maxActiveWorkers: 4 });
      engineA.providers.putModelProfiles({
        profiles: [
          {
            id: "orig",
            model: { provider: "orig-p", modelId: "orig-1" },
            description: "Original profile",
          },
        ],
      });
      await engineA.skills.putPolicy({ policy: { myskill: "disabled" } });
      await engineA.mcp().putConfig({
        servers: { g1: { type: "http", url: g1Url, exposure: "direct" } },
      });
      await engineA.oauthStore.forServer("g1", g1Url).save({
        serverUrl: g1Url,
        tokens: { access_token: "keep-me", token_type: "bearer" },
      });

      const project = engineA.projects.create({ workspaces: [ws], title: "ImportRollback" });
      await engineA.mcp(project.id).putConfig({
        servers: {
          g1: { enabled: false },
          projonly: { command: "proj-cmd", exposure: "direct" },
        },
      });

      const originalReload = engineA.mcpHub.reload.bind(engineA.mcpHub);
      let failOnce = true;
      engineA.mcpHub.reload = async (entries) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated import reload failure");
        }
        return originalReload(entries);
      };

      await assert.rejects(
        engineA.settings.importConfig({
          version: 1,
          settings: { maxActiveWorkers: 9 },
          modelProfiles: { profiles: [] },
          mcpServers: { g2: { command: "g2-cmd", exposure: "direct" } },
          modelsConfig: {
            providers: {
              imported: {
                baseUrl: "http://127.0.0.1:2/v1",
                api: "openai-responses",
                apiKey: "imp-key",
                models: [{ id: "imp-1", name: "Imported Model" }],
              },
            },
          },
        }),
        /simulated import reload failure/,
      );

      assert.deepEqual(readEngineSettings(engineA.store), { maxActiveWorkers: 4 });
      assert.deepEqual(readModelProfiles(engineA.store), {
        profiles: [
          {
            id: "orig",
            model: { provider: "orig-p", modelId: "orig-1" },
            description: "Original profile",
          },
        ],
      });
      assert.deepEqual(readGlobalSkillsPolicy(engineA.store), { myskill: "disabled" });
      assert.deepEqual(getMcpServersRecord(engineA.store), {
        g1: { type: "http", url: g1Url, exposure: "direct" },
      });
      assert.deepEqual(engineA.store.getProjectMcpServers(project.id), {
        g1: { enabled: false },
        projonly: { command: "proj-cmd", exposure: "direct" },
      });
      assert.equal(await readFile(join(homeWithModels, "models.json"), "utf8"), initialModelsRaw);
      assert.ok(engineA.modelRuntime.resolveModel({ provider: "orig-p", modelId: "orig-1" }));
      assert.equal(
        engineA.modelRuntime.resolveModel({ provider: "imported", modelId: "imp-1" }),
        undefined,
      );
      assert.equal(await engineA.oauthStore.hasTokens("g1", g1Url), true);
    } finally {
      await engineA.close();
    }

    const engineB = await Engine.open({ dataDir: homeWithoutModels, userHomeDir: null });
    try {
      engineB.mcpHub.reload = async () => {
        throw new Error("simulated fresh import failure");
      };

      await assert.rejects(
        engineB.settings.importConfig({
          version: 1,
          settings: { maxActiveWorkers: 7 },
          modelProfiles: { profiles: [] },
          mcpServers: {},
          modelsConfig: {
            providers: {
              imported: {
                baseUrl: "http://127.0.0.1:2/v1",
                api: "openai-responses",
                apiKey: "imp-key",
                models: [{ id: "imp-1", name: "Imported Model" }],
              },
            },
          },
        }),
        /simulated fresh import failure/,
      );

      await assert.rejects(stat(join(homeWithoutModels, "models.json")), { code: "ENOENT" });
      assert.deepEqual(engineB.modelRuntime.config(), { providers: {} });
      assert.deepEqual(readEngineSettings(engineB.store), {});
    } finally {
      await engineB.close();
    }
  });
});

test("deleteProject rejects concurrent project OAuth start and openProject once deletion begins", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const mock = await startMockOAuthMcpServer("proj_tool");

    const engine = await Engine.open({ dataDir: home, userHomeDir: null });
    try {
      const project = engine.projects.create({ workspaces: [ws], title: "DeleteRace" });
      await engine.mcp(project.id).putConfig({
        servers: {
          projhttp: { type: "http", url: mock.mcpUrl, exposure: "direct" },
        },
      });

      const session = await engine.mcp(project.id).startOAuth("projhttp");
      const sawAuthUrl = new Promise<void>((resolve, reject) => {
        const unsub = engine
          .mcp(project.id)
          .subscribeOAuth("projhttp", session.sessionId, (evt) => {
            if (evt.type === "auth_url") {
              unsub();
              resolve();
            } else if (evt.type === "error") {
              unsub();
              reject(new Error(evt.message));
            }
          });
      });
      await sawAuthUrl;

      const sawCancelled = new Promise<McpOAuthEvent>((resolve) => {
        const unsub = engine
          .mcp(project.id)
          .subscribeOAuth("projhttp", session.sessionId, (evt) => {
            if (evt.type === "error" || evt.type === "complete") {
              unsub();
              resolve(evt);
            }
          });
      });

      const deletePromise = engine.projects.delete(project.id);

      await assert.rejects(
        engine.mcp(project.id).startOAuth("projhttp"),
        (err: unknown) =>
          err instanceof EngineError && err.status === 404 && err.code === "project_not_found",
      );
      await assert.rejects(
        engine.openProject(project.id),
        (err: unknown) =>
          err instanceof EngineError && err.status === 404 && err.code === "project_not_found",
      );

      assert.deepEqual(await deletePromise, { ok: true, id: project.id });
      const lastEvent = await sawCancelled;
      assert.equal(lastEvent.type, "error");
      if (lastEvent.type === "error") {
        assert.equal(lastEvent.code, "login_cancelled");
      }
    } finally {
      await engine.close();
      await mock.close();
    }
  });
});
