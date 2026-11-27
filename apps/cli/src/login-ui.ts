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
  readonly streams?: LoginUiStreams;
};

export type RunMcpOAuthLoginOptions = {
  readonly client: EeveeClient;
  readonly serverName: string;
  readonly projectId?: string;
  readonly json?: boolean;
  readonly streams?: LoginUiStreams;
};

export type McpOAuthLoginResult =
  | { readonly ok: true; readonly server: string; readonly projectId?: string }
  | Extract<McpOAuthEvent, { readonly type: "error" }>;

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
  rl: ReadlineInterface,
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
    const choice = (await rl.question("Select [1/2]: ", { signal })).trim();
    if (choice === "1" || choice.toLowerCase() === "oauth") return "oauth";
    if (choice === "2" || choice.toLowerCase() === "api_key") return "api_key";
    throw new Error(`Invalid login method selection "${choice}"`);
  }
  throw new Error(
    `Provider "${provider.id}" does not support interactive login; pass --api-key <key>.`,
  );
}

async function readProviderPromptValue(
  prompt: LoginPromptEvent,
  promptOut: NodeJS.WritableStream,
  rl: ReadlineInterface,
  questionHidden: (query: string, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  if (prompt.type === "select") {
    promptOut.write(`${prompt.message}\n`);
    prompt.options.forEach((opt, idx) => {
      const desc = opt.description ? ` — ${opt.description}` : "";
      promptOut.write(`  ${idx + 1}) ${opt.label} (${opt.id})${desc}\n`);
    });
    const answer = (await rl.question("Select option: ", { signal })).trim();
    const asIndex = Number(answer);
    return Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= prompt.options.length
      ? (prompt.options[asIndex - 1]?.id ?? answer)
      : answer;
  }
  const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
  const query = `${prompt.message}${suffix}: `;
  return prompt.type === "secret" ? questionHidden(query, signal) : rl.question(query, { signal });
}

export async function runProviderLogin(
  options: RunProviderLoginOptions,
): Promise<LoginCompleteEvent | undefined> {
  const { providers } = await options.client.listProviders();
  const provider = providers.find((entry) => entry.id === options.providerId);
  if (provider === undefined) throw new Error(`Unknown provider "${options.providerId}"`);

  const { stdin, promptOut, isTTY } = resolveStreams(options.streams, options.json);
  let echoMuted = false;
  const echoOut = new Writable({
    write(chunk, encoding, callback) {
      if (echoMuted) callback();
      else promptOut.write(chunk, encoding, () => callback());
    },
  });
  const rl = createInterface({ input: stdin, output: echoOut, terminal: isTTY });
  const questionHidden = async (query: string, signal: AbortSignal): Promise<string> => {
    promptOut.write(query);
    echoMuted = true;
    try {
      return await rl.question("", { signal });
    } finally {
      echoMuted = false;
      promptOut.write("\n");
    }
  };

  let sessionId: string | undefined;
  let cancelPromise: Promise<unknown> | undefined;
  const cancelProvider = (id: string) =>
    options.client.cancelLoginSession(options.providerId, id).catch(() => undefined);

  try {
    return await withSignalAbort(
      async (signal) => {
        const loginType = await selectProviderLoginType(
          provider,
          options.oauth,
          promptOut,
          rl,
          signal,
        );
        const session = await options.client.startProviderLogin(
          options.providerId,
          { type: loginType },
          signal,
        );
        sessionId = session.sessionId;
        if (signal.aborted) {
          cancelPromise = cancelProvider(sessionId);
          return undefined;
        }
        try {
          for await (const item of options.client.streamLoginSession(
            options.providerId,
            sessionId,
            { signal },
          )) {
            if (item.type === "auth") writeAuthEvent(promptOut, item.event);
            else if (item.type === "prompt") {
              const value = await readProviderPromptValue(
                item.prompt,
                promptOut,
                rl,
                questionHidden,
                signal,
              );
              await options.client.submitLoginInput(options.providerId, sessionId, {
                promptId: item.prompt.promptId,
                value,
              });
            } else if (item.type === "complete") return item.complete;
            else if (item.type === "error") throw new Error(item.error.message);
          }
          return undefined;
        } finally {
          await cancelPromise;
        }
      },
      () => {
        rl.close();
        if (sessionId !== undefined) cancelPromise = cancelProvider(sessionId);
      },
    );
  } finally {
    rl.close();
  }
}

export async function runMcpOAuthLogin(
  options: RunMcpOAuthLoginOptions,
): Promise<McpOAuthLoginResult | undefined> {
  const { stdin, promptOut, isTTY } = resolveStreams(options.streams, options.json);
  const mcp = options.client.mcp(options.projectId);
  const promptController = new AbortController();
  let rl: ReadlineInterface | undefined;
  let promptStarted = false;
  let promptTask: Promise<void> | undefined;
  let cancelPromise: Promise<unknown> | undefined;
  let sessionId: string | undefined;

  const startManualRedirectPrompt = (activeSessionId: string, signal: AbortSignal) => {
    if (promptStarted || !isTTY) return;
    promptStarted = true;
    const iface = createInterface({ input: stdin, output: promptOut, terminal: true });
    rl = iface;
    promptTask = (async () => {
      try {
        while (!promptController.signal.aborted && !signal.aborted) {
          const answer = await iface.question("Paste redirect URL (or press Ctrl+C to cancel): ", {
            signal: promptController.signal,
          });
          const redirectUrl = answer.trim();
          if (redirectUrl.length === 0) continue;
          try {
            await mcp.submitOAuthInput(options.serverName, activeSessionId, { redirectUrl });
            return;
          } catch (error) {
            if (promptController.signal.aborted || signal.aborted) return;
            promptOut.write(`${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      } catch {
        // Abort or closed readline stops manual prompt when loopback completes or cancels.
      } finally {
        iface.close();
      }
    })();
  };

  const cancelMcp = (id: string) => mcp.cancelOAuth(options.serverName, id).catch(() => undefined);

  const terminalEvent = await withSignalAbort(
    async (signal) => {
      try {
        const session = await mcp.startOAuth(options.serverName, signal);
        sessionId = session.sessionId;
        if (signal.aborted) {
          cancelPromise = cancelMcp(sessionId);
          return undefined;
        }
        for await (const event of mcp.streamOAuth(options.serverName, sessionId, { signal })) {
          if (event.type === "auth_url") {
            writeAuthEvent(promptOut, event);
            startManualRedirectPrompt(sessionId, signal);
          } else if (event.type === "progress") {
            writeAuthEvent(promptOut, event);
          } else if (event.type === "complete" || event.type === "error") {
            return event;
          }
        }
        if (!signal.aborted) throw new Error("MCP OAuth sign-in stream ended unexpectedly");
        return undefined;
      } finally {
        promptController.abort();
        rl?.close();
        await promptTask;
        await cancelPromise;
      }
    },
    () => {
      promptController.abort();
      rl?.close();
      if (sessionId !== undefined) cancelPromise = cancelMcp(sessionId);
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
