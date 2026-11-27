import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type {
  AuthType,
  EeveeClient,
  LoginAuthEvent,
  LoginCompleteEvent,
  LoginPromptEvent,
  McpOAuthEvent,
  ProviderSummary,
} from "@eevee/protocol";
import { withSignalAbort } from "./command-helpers.ts";

export type LoginUiStreams = {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
};

export type RunProviderLoginOptions = {
  readonly client: EeveeClient;
  readonly providerId: string;
  readonly oauth?: boolean;
  readonly json?: boolean;
  readonly signal?: AbortSignal;
  readonly streams?: LoginUiStreams;
};

export type RunMcpOAuthLoginOptions = {
  readonly client: EeveeClient;
  readonly serverName: string;
  readonly projectId?: string;
  readonly json?: boolean;
  readonly signal?: AbortSignal;
  readonly streams?: LoginUiStreams;
};

export type McpOAuthLoginResult =
  | { readonly ok: true; readonly server: string; readonly projectId?: string }
  | Extract<McpOAuthEvent, { readonly type: "error" }>;

type PromptReader = {
  readonly rl: ReadlineInterface;
  question(query: string, signal: AbortSignal): Promise<string>;
  readSecretLine(query: string, signal: AbortSignal): Promise<string>;
};

type CancelableSessionContext = {
  readonly signal: AbortSignal;
  setSessionId(id: string): boolean;
  registerReadline(rl: ReadlineInterface): void;
  setAbortCleanup(cleanup: () => void): void;
};

function createPromptReader(
  stdin: NodeJS.ReadableStream,
  promptOut: NodeJS.WritableStream,
  isTTY: boolean,
): PromptReader {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (muted) callback();
      else promptOut.write(chunk, encoding, () => callback());
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: isTTY });
  return {
    rl,
    question: (query, signal) => rl.question(query, { signal }),
    async readSecretLine(query, signal) {
      promptOut.write(query);
      muted = true;
      try {
        return await rl.question("", { signal });
      } finally {
        muted = false;
        promptOut.write("\n");
      }
    },
  };
}

async function withCancelableSession<T>(
  options: {
    readonly signal?: AbortSignal;
    readonly cancelSession: (sessionId: string) => Promise<unknown>;
    readonly cleanup?: () => Promise<void> | void;
  },
  run: (ctx: CancelableSessionContext) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (options.signal?.aborted) return undefined;

  let sessionId: string | undefined;
  let cancelPromise: Promise<unknown> | undefined;
  let activeRl: ReadlineInterface | undefined;
  let extraAbortCleanup: (() => void) | undefined;

  const triggerCancel = () => {
    extraAbortCleanup?.();
    activeRl?.close();
    if (sessionId !== undefined && cancelPromise === undefined) {
      cancelPromise = options.cancelSession(sessionId).catch(() => undefined);
    }
  };

  const execute = async (signal: AbortSignal): Promise<T | undefined> => {
    const ctx: CancelableSessionContext = {
      signal,
      setSessionId(id: string): boolean {
        sessionId = id;
        if (signal.aborted) {
          triggerCancel();
          return false;
        }
        return true;
      },
      registerReadline(rl: ReadlineInterface): void {
        activeRl = rl;
        if (signal.aborted) rl.close();
      },
      setAbortCleanup(cleanup: () => void): void {
        extraAbortCleanup = cleanup;
      },
    };

    try {
      return await run(ctx);
    } finally {
      activeRl?.close();
      await options.cleanup?.();
      await cancelPromise;
    }
  };

  if (options.signal === undefined) {
    return withSignalAbort(execute, triggerCancel);
  }

  const signal = options.signal;
  signal.addEventListener("abort", triggerCancel, { once: true });
  try {
    return await execute(signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    return undefined;
  } finally {
    signal.removeEventListener("abort", triggerCancel);
  }
}

function resolveStreams(streams: LoginUiStreams | undefined, json: boolean | undefined) {
  const stdin = streams?.stdin ?? process.stdin;
  const isTTY = streams?.isTTY ?? (stdin as { isTTY?: boolean }).isTTY === true;
  return {
    stdin,
    promptOut: json ? (streams?.stderr ?? process.stderr) : (streams?.stdout ?? process.stdout),
    isTTY,
  };
}

function writeAuthEvent(
  promptOut: NodeJS.WritableStream,
  event: LoginAuthEvent | Extract<McpOAuthEvent, { readonly type: "auth_url" | "progress" }>,
): void {
  if (event.type === "auth_url") {
    promptOut.write(`Open URL: ${event.url}\n`);
    if (event.instructions) promptOut.write(`${event.instructions}\n`);
    return;
  }
  if (event.type === "device_code") {
    promptOut.write(`Enter code ${event.userCode} at ${event.verificationUri}\n`);
    return;
  }
  promptOut.write(`${event.message}\n`);
}

async function selectProviderLoginType(
  provider: ProviderSummary,
  oauthFlag: boolean | undefined,
  promptOut: NodeJS.WritableStream,
  prompt: PromptReader,
  signal: AbortSignal,
): Promise<AuthType> {
  if (oauthFlag) {
    if (!provider.authMethods.oauth) {
      throw new Error(`Provider "${provider.id}" does not support OAuth login`);
    }
    return "oauth";
  }
  if (provider.authMethods.oauth && !provider.authMethods.apiKeyLogin) return "oauth";
  if (!provider.authMethods.oauth && provider.authMethods.apiKeyLogin) return "api_key";
  if (provider.authMethods.oauth && provider.authMethods.apiKeyLogin) {
    const oauthLabel = provider.authMethods.oauthLabel ?? provider.authMethods.oauthName ?? "OAuth";
    promptOut.write(
      `Choose login method for ${provider.name}:\n  1) ${oauthLabel}\n  2) API key\n`,
    );
    const choice = (await prompt.question("Select [1/2]: ", signal)).trim();
    if (choice === "1" || choice.toLowerCase() === "oauth") return "oauth";
    if (choice === "2" || choice.toLowerCase() === "api_key") return "api_key";
    throw new Error(`Invalid login method selection "${choice}"`);
  }
  throw new Error(
    `Provider "${provider.id}" does not support interactive login; pass --api-key <key>.`,
  );
}

async function readProviderPromptValue(
  promptEvent: LoginPromptEvent,
  promptOut: NodeJS.WritableStream,
  prompt: PromptReader,
  signal: AbortSignal,
): Promise<string> {
  if (promptEvent.type === "select") {
    promptOut.write(`${promptEvent.message}\n`);
    promptEvent.options.forEach((opt, idx) => {
      const desc = opt.description ? ` — ${opt.description}` : "";
      promptOut.write(`  ${idx + 1}) ${opt.label} (${opt.id})${desc}\n`);
    });
    const answer = (await prompt.question("Select option: ", signal)).trim();
    const asIndex = Number(answer);
    return Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= promptEvent.options.length
      ? (promptEvent.options[asIndex - 1]?.id ?? answer)
      : answer;
  }
  const suffix = promptEvent.placeholder ? ` (${promptEvent.placeholder})` : "";
  const query = `${promptEvent.message}${suffix}: `;
  return promptEvent.type === "secret"
    ? prompt.readSecretLine(query, signal)
    : prompt.question(query, signal);
}

export async function runProviderLogin(
  options: RunProviderLoginOptions,
): Promise<LoginCompleteEvent | undefined> {
  return withCancelableSession(
    {
      signal: options.signal,
      cancelSession: (id) => options.client.cancelLoginSession(options.providerId, id),
    },
    async (ctx) => {
      const { providers } = await options.client.listProviders(ctx.signal);
      const provider = providers.find((entry) => entry.id === options.providerId);
      if (provider === undefined) throw new Error(`Unknown provider "${options.providerId}"`);

      const { stdin, promptOut, isTTY } = resolveStreams(options.streams, options.json);
      const prompt = createPromptReader(stdin, promptOut, isTTY);
      ctx.registerReadline(prompt.rl);

      const loginType = await selectProviderLoginType(
        provider,
        options.oauth,
        promptOut,
        prompt,
        ctx.signal,
      );
      const session = await options.client.startProviderLogin(
        options.providerId,
        { type: loginType },
        ctx.signal,
      );
      if (!ctx.setSessionId(session.sessionId)) return undefined;

      for await (const item of options.client.streamLoginSession(
        options.providerId,
        session.sessionId,
        { signal: ctx.signal },
      )) {
        if (item.type === "auth") writeAuthEvent(promptOut, item.event);
        else if (item.type === "prompt") {
          const value = await readProviderPromptValue(item.prompt, promptOut, prompt, ctx.signal);
          await options.client.submitLoginInput(
            options.providerId,
            session.sessionId,
            { promptId: item.prompt.promptId, value },
            ctx.signal,
          );
        } else if (item.type === "complete") return item.complete;
        else if (item.type === "error") throw new Error(item.error.message);
      }
      return undefined;
    },
  );
}

export async function runMcpOAuthLogin(
  options: RunMcpOAuthLoginOptions,
): Promise<McpOAuthLoginResult | undefined> {
  const { stdin, promptOut, isTTY } = resolveStreams(options.streams, options.json);
  const mcp = options.client.mcp(options.projectId);
  const promptController = new AbortController();
  let promptTask: Promise<void> | undefined;

  const startManualRedirectPrompt = (ctx: CancelableSessionContext, activeSessionId: string) => {
    if (promptTask !== undefined || !isTTY) return;
    const rl = createInterface({ input: stdin, output: promptOut, terminal: true });
    ctx.registerReadline(rl);
    promptTask = (async () => {
      try {
        while (!promptController.signal.aborted && !ctx.signal.aborted) {
          const answer = await rl.question("Paste redirect URL (or press Ctrl+C to cancel): ", {
            signal: promptController.signal,
          });
          const redirectUrl = answer.trim();
          if (redirectUrl.length === 0) continue;
          try {
            await mcp.submitOAuthInput(
              options.serverName,
              activeSessionId,
              { redirectUrl },
              ctx.signal,
            );
            return;
          } catch (error) {
            if (promptController.signal.aborted || ctx.signal.aborted) return;
            promptOut.write(`${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      } catch {
      } finally {
        rl.close();
      }
    })();
  };

  const terminalEvent = await withCancelableSession(
    {
      signal: options.signal,
      cancelSession: (id) => mcp.cancelOAuth(options.serverName, id),
      cleanup: async () => {
        promptController.abort();
        await promptTask;
      },
    },
    async (ctx) => {
      ctx.setAbortCleanup(() => promptController.abort());
      const session = await mcp.startOAuth(options.serverName, ctx.signal);
      if (!ctx.setSessionId(session.sessionId)) return undefined;

      for await (const event of mcp.streamOAuth(options.serverName, session.sessionId, {
        signal: ctx.signal,
      })) {
        if (event.type === "auth_url") {
          writeAuthEvent(promptOut, event);
          startManualRedirectPrompt(ctx, session.sessionId);
        } else if (event.type === "progress") {
          writeAuthEvent(promptOut, event);
        } else if (event.type === "complete" || event.type === "error") {
          return event;
        }
      }
      if (!ctx.signal.aborted) throw new Error("MCP OAuth sign-in stream ended unexpectedly");
      return undefined;
    },
  );

  if (terminalEvent === undefined) return undefined;
  if (terminalEvent.type === "error") {
    if (!options.json) throw new Error(`${terminalEvent.message} (${terminalEvent.code})`);
    process.exitCode = 1;
    return terminalEvent;
  }
  return {
    ok: true,
    server: options.serverName,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
  };
}
