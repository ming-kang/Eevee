import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ConversationRef,
  ConversationRefSchema,
  type ModelChoice,
  type ModelSlotsOverride,
  parseWithSchema,
} from "@eevee/protocol";

export function parsePort(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid port "${raw}": expected integer 0..65535`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${raw}": expected integer 0..65535`);
  }
  return port;
}

export function parsePositiveIntFlag(raw: string, flagName: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid ${flagName} "${raw}": expected positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${flagName} "${raw}": expected positive integer`);
  }
  return value;
}

export function parseNonNegativeIntFlag(raw: string, flagName: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`Invalid ${flagName} "${raw}": expected non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${flagName} "${raw}": expected non-negative integer`);
  }
  return value;
}

export function parseIntRangeFlag(raw: string, flagName: string, min: number, max: number): number {
  if (!/^-?[0-9]+$/.test(raw)) {
    throw new Error(`Invalid ${flagName} "${raw}": expected integer ${min}..${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${flagName} "${raw}": expected integer ${min}..${max}`);
  }
  return value;
}

export function parseConversationRefArg(raw: string | undefined): ConversationRef {
  return parseWithSchema(ConversationRefSchema, raw ?? "router", "ref");
}

export function parseNonEmptyTaskId(raw: string): string {
  if (raw.trim().length === 0) {
    throw new Error("Invalid taskId: must not be empty");
  }
  return raw;
}

export function parseModelFlag(spec: string, flagName: string): ModelChoice {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`Invalid ${flagName} "${spec}": expected <provider>/<modelId>`);
  }
  return {
    provider: spec.slice(0, slash),
    modelId: spec.slice(slash + 1),
  };
}

export function parseModelSlotFlags(options: {
  readonly routerModel?: string;
  readonly workerModel?: string;
  readonly dreamerModel?: string;
}): ModelSlotsOverride {
  return {
    ...(options.routerModel === undefined
      ? {}
      : { router: parseModelFlag(options.routerModel, "--router-model") }),
    ...(options.workerModel === undefined
      ? {}
      : { worker: parseModelFlag(options.workerModel, "--worker-model") }),
    ...(options.dreamerModel === undefined
      ? {}
      : { dreamer: parseModelFlag(options.dreamerModel, "--dreamer-model") }),
  };
}

export function hasModelSlots(models: ModelSlotsOverride): boolean {
  return models.router !== undefined || models.worker !== undefined || models.dreamer !== undefined;
}

export function installSignalAbort(controller: AbortController): () => void {
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Provide --file <path> or pipe input via stdin.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readTextInput(filePath?: string): Promise<string> {
  if (filePath !== undefined) {
    return readFile(resolve(filePath), "utf8");
  }
  return readStdinText();
}

export async function readJsonInput(filePath?: string): Promise<unknown> {
  const raw = await readTextInput(filePath);
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseKeyValueFlags(
  entries: readonly string[] | undefined,
  flagName: string,
): Record<string, string> | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const record: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid ${flagName} "${entry}": expected KEY=VALUE`);
    }
    record[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return record;
}
