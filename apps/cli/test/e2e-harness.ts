import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthToken, readEngineState } from "@eevee/engine";
import { EeveeClient } from "@eevee/protocol";

export const CLI_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export type ScriptedToolCall = {
  readonly id?: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

export type ScriptedOpenAiUsage = {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
};

export type ScriptedOpenAiTurn = {
  readonly textChunks?: readonly string[];
  readonly toolCalls?: readonly ScriptedToolCall[];
  readonly finishReason?: "stop" | "tool_calls";
  readonly chunkDelayMs?: number;
  readonly usage?: ScriptedOpenAiUsage;
  readonly status?: number;
  readonly errorBody?: unknown;
};

export type RecordedOpenAiRequest = {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: {
    readonly model?: string;
    readonly messages: readonly Record<string, unknown>[];
    readonly tools?: readonly unknown[];
  };
};

export type ScriptedOpenAiServer = {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: RecordedOpenAiRequest[];
  close(): Promise<void>;
};

export type LastRequestMessage = {
  readonly role: string;
  readonly toolName?: string;
  readonly text: string;
};

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

function toolNameOfCall(
  messages: readonly Record<string, unknown>[],
  toolCallId: unknown,
): string | undefined {
  if (typeof toolCallId !== "string") return undefined;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as { id?: unknown; function?: { name?: unknown } }[]) {
      if (call.id === toolCallId && typeof call.function?.name === "string") {
        return call.function.name;
      }
    }
  }
  return undefined;
}

export function lastUserOrToolMessage(request: RecordedOpenAiRequest): LastRequestMessage {
  const messages = request.body.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.role === "user") return { role: "user", text: messageContentText(msg.content) };
    if (msg.role === "tool") {
      const toolName =
        typeof msg.name === "string" ? msg.name : toolNameOfCall(messages, msg.tool_call_id);
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return { role: "tool", ...(toolName === undefined ? {} : { toolName }), text };
    }
  }
  return { role: "unknown", text: "" };
}

export async function waitFor(
  check: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(40);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

function writeSseChunk(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function createScriptedOpenAiServer(
  resolveTurn: (
    request: RecordedOpenAiRequest,
    index: number,
  ) => ScriptedOpenAiTurn | Promise<ScriptedOpenAiTurn>,
): Promise<ScriptedOpenAiServer> {
  const requests: RecordedOpenAiRequest[] = [];
  let seq = 0;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";
        if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Unhandled ${req.method} ${url}` } }));
          return;
        }

        const body = (await readBodyJson(req)) as RecordedOpenAiRequest["body"];
        const recorded: RecordedOpenAiRequest = { url, headers: req.headers, body };
        const turnIndex = requests.length;
        requests.push(recorded);

        const turn = await resolveTurn(recorded, turnIndex);
        if (turn.status !== undefined && turn.status >= 400) {
          res.writeHead(turn.status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(turn.errorBody ?? { error: { message: `Mock error ${turn.status}` } }),
          );
          return;
        }

        const completionId = `chatcmpl-mock-${++seq}`;
        const model = body.model ?? "test-model";
        const delay = turn.chunkDelayMs ?? 0;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        writeSseChunk(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });

        for (const textChunk of turn.textChunks ?? []) {
          if (delay > 0) await sleep(delay);
          writeSseChunk(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: textChunk }, finish_reason: null }],
          });
        }

        const toolCalls = turn.toolCalls ?? [];
        for (let index = 0; index < toolCalls.length; index++) {
          const toolCall = toolCalls[index];
          if (toolCall === undefined) continue;
          const callId = toolCall.id ?? `call_mock_${seq}_${index + 1}`;
          if (delay > 0) await sleep(delay);
          writeSseChunk(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: callId,
                      type: "function",
                      function: { name: toolCall.name, arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          writeSseChunk(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      function: { arguments: JSON.stringify(toolCall.arguments) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }

        const finishReason = turn.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
        writeSseChunk(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: turn.usage ?? { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
        if (!res.writableEnded && !res.destroyed) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: error instanceof Error ? error.message : String(error) },
            }),
          );
        } else if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Expected TCP address for mock OpenAI server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    close: async () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) reject(error);
          else resolve();
        });
      });
    },
  };
}

export type CliRunResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunningCliProcess = {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  waitForStdout(predicate: (stdout: string) => boolean, timeoutMs?: number): Promise<string>;
  stop(): Promise<CliRunResult>;
};

export async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Timed out waiting for child process ${child.pid ?? "?"} to exit`));
    }, timeoutMs);
    timer.unref?.();
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

export async function stopChildProcess(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exiting = waitForChildExit(child, timeoutMs);
  child.kill("SIGTERM");
  try {
    return await exiting;
  } catch {
    child.kill("SIGKILL");
    return await waitForChildExit(child, 5_000);
  }
}

export type E2eFixture = {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly workspaceDir: string;
  readonly mockOpenAi: ScriptedOpenAiServer;
  readonly engineChild: ChildProcess;
  readonly engineUrl: string;
  readonly engineToken: string;
  readonly client: EeveeClient;
  runCli(
    args: readonly string[],
    options?: { readonly env?: Record<string, string | undefined>; readonly cwd?: string },
  ): Promise<CliRunResult>;
  spawnCli(
    args: readonly string[],
    options?: { readonly env?: Record<string, string | undefined>; readonly cwd?: string },
  ): RunningCliProcess;
  cleanup(): Promise<void>;
};

export type StartE2eFixtureOptions = {
  readonly resolveTurn: (
    request: RecordedOpenAiRequest,
    index: number,
  ) => ScriptedOpenAiTurn | Promise<ScriptedOpenAiTurn>;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelsConfig?: (baseUrl: string) => Record<string, unknown>;
};

export async function startE2eFixture(options: StartE2eFixtureOptions): Promise<E2eFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "eevee-e2e-"));
  const homeDir = join(rootDir, "home");
  const workspaceDir = join(rootDir, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const providerId = options.providerId ?? "mock";
  const modelId = options.modelId ?? "test-model";
  const mockOpenAi = await createScriptedOpenAiServer(options.resolveTurn);

  const modelsJson = options.modelsConfig
    ? options.modelsConfig(mockOpenAi.baseUrl)
    : {
        providers: {
          [providerId]: {
            baseUrl: mockOpenAi.baseUrl,
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: modelId, reasoning: false }],
          },
        },
      };

  await writeFile(join(homeDir, "models.json"), JSON.stringify(modelsJson, null, 2), "utf8");

  const engineStdout: string[] = [];
  const engineStderr: string[] = [];
  const engineChild = spawn(
    process.execPath,
    ["--conditions=eevee-source", CLI_ENTRY, "start", "--foreground", "--port", "0"],
    {
      env: { ...process.env, EEVEE_HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  engineChild.stdout?.on("data", (chunk: Buffer) => engineStdout.push(chunk.toString("utf8")));
  engineChild.stderr?.on("data", (chunk: Buffer) => engineStderr.push(chunk.toString("utf8")));

  const activeChildren = new Set<ChildProcess>();

  const cleanup = async () => {
    for (const child of [...activeChildren]) {
      await stopChildProcess(child).catch(() => undefined);
    }
    activeChildren.clear();
    await stopChildProcess(engineChild).catch(() => undefined);
    await mockOpenAi.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  try {
    const ready = await waitForEngineReady({
      homeDir,
      engineChild,
      stdout: () => engineStdout.join(""),
      stderr: () => engineStderr.join(""),
    });

    const runCli: E2eFixture["runCli"] = async (args, opts = {}) => {
      const child = spawn(process.execPath, ["--conditions=eevee-source", CLI_ENTRY, ...args], {
        cwd: opts.cwd ?? workspaceDir,
        env: { ...process.env, EEVEE_HOME: homeDir, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChildren.add(child);
      const out: string[] = [];
      const err: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk.toString("utf8")));
      try {
        const result = await waitForChildExit(child, 30_000);
        return {
          ...result,
          stdout: out.join(""),
          stderr: err.join(""),
        };
      } finally {
        activeChildren.delete(child);
      }
    };

    const spawnCli: E2eFixture["spawnCli"] = (args, opts = {}) => {
      const child = spawn(process.execPath, ["--conditions=eevee-source", CLI_ENTRY, ...args], {
        cwd: opts.cwd ?? workspaceDir,
        env: { ...process.env, EEVEE_HOME: homeDir, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChildren.add(child);
      const out: string[] = [];
      const err: string[] = [];
      const waiters = new Set<() => void>();
      const notify = () => {
        for (const fn of waiters) fn();
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        out.push(chunk.toString("utf8"));
        notify();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err.push(chunk.toString("utf8"));
        notify();
      });
      child.once("exit", () => {
        activeChildren.delete(child);
        notify();
      });

      return {
        child,
        stdout: () => out.join(""),
        stderr: () => err.join(""),
        waitForStdout: (predicate, timeoutMs = 15_000) =>
          new Promise<string>((resolve, reject) => {
            const check = () => {
              const current = out.join("");
              if (predicate(current)) {
                cleanupWait();
                resolve(current);
                return true;
              }
              return false;
            };
            const timer = setTimeout(() => {
              cleanupWait();
              reject(
                new Error(
                  `Timed out waiting for CLI stdout.\nstdout:\n${out.join("")}\nstderr:\n${err.join("")}`,
                ),
              );
            }, timeoutMs);
            timer.unref?.();
            const onUpdate = () => {
              void check();
            };
            const cleanupWait = () => {
              clearTimeout(timer);
              waiters.delete(onUpdate);
            };
            waiters.add(onUpdate);
            void check();
          }),
        stop: async () => {
          const result = await stopChildProcess(child);
          activeChildren.delete(child);
          return {
            ...result,
            stdout: out.join(""),
            stderr: err.join(""),
          };
        },
      };
    };

    return {
      rootDir,
      homeDir,
      workspaceDir,
      mockOpenAi,
      engineChild,
      engineUrl: ready.url,
      engineToken: ready.token,
      client: ready.client,
      runCli,
      spawnCli,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

async function waitForEngineReady(input: {
  readonly homeDir: string;
  readonly engineChild: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
}): Promise<{ readonly url: string; readonly token: string; readonly client: EeveeClient }> {
  const stateFile = join(input.homeDir, "engine.json");
  const tokenFile = join(input.homeDir, "engine.token");
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (input.engineChild.exitCode !== null || input.engineChild.signalCode !== null) {
      throw new Error(
        `Engine child exited prematurely (code=${input.engineChild.exitCode}, signal=${input.engineChild.signalCode})\nstdout:\n${input.stdout()}\nstderr:\n${input.stderr()}`,
      );
    }

    const state = await readEngineState(stateFile).catch(() => undefined);
    const token = await readAuthToken(tokenFile).catch(() => undefined);
    if (state !== undefined && token !== undefined) {
      const client = new EeveeClient({ baseUrl: state.url, token });
      try {
        const health = await client.health();
        if (health.ok) return { url: state.url, token, client };
      } catch {
        // Server still binding or starting up.
      }
    }
    await sleep(30);
  }

  throw new Error(
    `Timed out waiting for Engine child to become healthy.\nstdout:\n${input.stdout()}\nstderr:\n${input.stderr()}`,
  );
}
