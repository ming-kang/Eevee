import type {
  Context,
  Models,
  ModelsSimpleStreamOptions,
  ModelThinkingLevel,
  Tool,
} from "@earendil-works/pi-ai";
import { errorMessage } from "../shared/guards.ts";
import { extractAuthSecrets, redactSecrets, withAbortTimeout } from "./sanitize.ts";

export type ModelSmokeTestOptions = {
  readonly models: Models;
  readonly providerId: string;
  readonly modelId: string;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly testTools?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type ModelSmokeTestResult = {
  readonly ok: boolean;
  readonly ttftMs?: number;
  readonly totalMs: number;
  readonly sawReasoning: boolean;
  readonly sawToolCall: boolean;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly totalTokens: number;
  };
  readonly replyPreview: string;
  readonly error?: string;
};

const SMOKE_TOOL: Tool = {
  name: "eevee_smoke_test",
  description:
    "Test tool. Call it with no arguments instead of answering if a tool call is requested.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const DEFAULT_SMOKE_TIMEOUT_MS = 20_000;
const MAX_SMOKE_ERROR_CHARS = 1000;

export async function runModelSmokeTest(
  options: ModelSmokeTestOptions,
): Promise<ModelSmokeTestResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  let secrets: string[] = [];
  let ttftMs: number | undefined;
  let sawReasoning = false;
  let sawToolCall = false;
  let reply = "";
  let usage: ModelSmokeTestResult["usage"];

  return withAbortTimeout(timeoutMs, options.signal, async ({ signal, timedOut }) => {
    try {
      signal.throwIfAborted();
      const model = options.models.getModel(options.providerId, options.modelId);
      if (!model) throw new Error(`Model not found: ${options.providerId}/${options.modelId}`);
      const auth =
        typeof options.models.getAuth === "function"
          ? await options.models.getAuth(model, { signal })
          : undefined;
      signal.throwIfAborted();
      if (typeof options.models.getAuth === "function" && !auth) {
        throw new Error(`Provider is not configured: ${options.providerId}`);
      }
      secrets = extractAuthSecrets(auth?.auth);

      const context: Context = {
        systemPrompt: "You are running a minimal connectivity test.",
        messages: [
          {
            role: "user",
            content: "Reply with the single word OK.",
            timestamp: Date.now(),
          },
        ],
        ...(options.testTools ? { tools: [SMOKE_TOOL] } : {}),
      };
      const streamOptions: ModelsSimpleStreamOptions = {
        maxTokens: 32,
        signal,
        ...(auth?.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
        ...(auth?.auth.headers === undefined ? {} : { headers: auth.auth.headers }),
        ...(options.thinkingLevel !== undefined && options.thinkingLevel !== "off"
          ? { reasoning: options.thinkingLevel }
          : {}),
      };
      const stream = options.models.streamSimple(model, context, streamOptions);
      let failure: string | undefined;

      for await (const event of stream) {
        if (
          (event.type === "text_delta" ||
            event.type === "thinking_delta" ||
            event.type === "toolcall_delta") &&
          ttftMs === undefined
        ) {
          ttftMs = Date.now() - started;
        }
        if (event.type === "text_delta") reply += event.delta;
        if (event.type === "thinking_delta" || event.type === "thinking_start") sawReasoning = true;
        if (event.type.startsWith("toolcall_")) sawToolCall = true;
        if (event.type === "done") {
          reply = event.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          sawReasoning ||= event.message.content.some((block) => block.type === "thinking");
          sawToolCall ||= event.message.content.some((block) => block.type === "toolCall");
          usage = {
            input: event.message.usage.input,
            output: event.message.usage.output,
            totalTokens: event.message.usage.totalTokens,
          };
        } else if (event.type === "error") {
          failure = event.error.errorMessage ?? `Model request ${event.reason}`;
        }
      }

      if (failure) throw new Error(failure);
      return {
        ok: true,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        totalMs: Date.now() - started,
        sawReasoning,
        sawToolCall,
        ...(usage ? { usage } : {}),
        replyPreview: reply.slice(0, 500),
      };
    } catch (error) {
      const prefix = timedOut()
        ? `Model smoke test timed out after ${timeoutMs}ms`
        : options.signal?.aborted
          ? "Model smoke test aborted"
          : errorMessage(error);
      return {
        ok: false,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        totalMs: Date.now() - started,
        sawReasoning,
        sawToolCall,
        ...(usage ? { usage } : {}),
        replyPreview: reply.slice(0, 500),
        error: redactSecrets(prefix, secrets, MAX_SMOKE_ERROR_CHARS),
      };
    }
  });
}
